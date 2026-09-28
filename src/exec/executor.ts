import { fetchMacroBundle, MAX_SERIES_LAG_DAYS } from "../data/fred.js";
import { computeRegimeTimeline, WARMUP_DAYS, type RegimeConfig, type RegimePoint } from "../strategy/regime.js";
import {
  composeEquityTarget,
  latestVolMultiplier,
  latestValuationTilt,
  type ValuationConfig,
  type VolTargetConfig,
} from "../strategy/overlays.js";
import type { TradeDriver } from "../strategy/drivers.js";
import {
  initSchema,
  latestPrices,
  loadPortfolio,
  loadRuntimeState,
  recordTrades,
  savePortfolio,
  saveRuntimeState,
  saveExecutorPreview,
  upcomingEarnings,
  latestAdv,
  upsertEarningsDates,
  getPool,
  usClosesByTicker,
} from "../db/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseFredCsv } from "../data/stats.js";
import type { Point } from "../data/stats.js";
import { loadCape } from "../backtest/context.js";

/**
 * 执行器：六个模块（定投/体制/波动率目标/估值锚/漂移/财报）→ 一张目标权重表 → 与当前组合求差额 → 交易。
 *
 * 目标仓位三层合成与回测同口径：体制档位（含 Sahm 门）× 波动率乘数 × (1+估值偏移)，
 * 个股层再叠加财报缩放。纸面成交价 = 最近同步收盘价，成本逐笔计提（半价差+√冲击，按 ADV20；
 * 无成交量数据退回 slippagePercent），现金按 DGS3MO 日频计息。
 *
 * dryRun = true 时全流程照算但不落任何库——这是"下一轮会做什么"的预演入口。
 * 正常运行还会写一份 executor_preview（下一轮预告，确定性规则可提前算出下轮动作）。
 */

export interface ExecutorConfig {
  tickers: string[];
  /** 账本分区标签（paper），与回测的 backtest 分区区分 */
  mode: string;
  startCash: number;
  dcaUsdt: number;
  driftThresholdPp: number;
  minTradeUsdt: number;
  /** 无成交量数据时的退回单边成本（百分比） */
  slippagePercent: number;
  regime: RegimeConfig;
  earnings: { enabled: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
  volTarget: VolTargetConfig & { enabled: boolean };
  valuation: ValuationConfig & { enabled: boolean };
  cost: { halfSpreadBps: number; impactCoef: number; earningsMult: number };
  cashInterest: boolean;
  /** 只算不写：跳过全部持久化，返回值里带完整预告 */
  dryRun?: boolean;
  /** 策略配置签名：与 runtime_state.sig 不一致 → 本轮立即对齐新目标表（retarget） */
  configSig?: string;
}

export interface ExecutionSummary {
  asOf: string;
  regime: RegimePoint;
  prices: Map<string, number>;
  portfolioBefore: { cash: number; positions: Map<string, number> };
  equityBefore: number;
  targetWeights: Record<string, number>;
  /** 三层合成的目标股票仓位（体制 × 波动率 × 估值） */
  composedEquityTarget: number;
  composition: { regimeTarget: number; volMult: number | undefined; tilt: number | undefined };
  /** 本轮计提的现金利息（美元；未启用或无利率数据为 0） */
  cashInterestUsd: number;
  trades: {
    date: string;
    ticker: string;
    unitsDelta: number;
    notionalUsdt: number;
    costUsd: number;
    drivers: TradeDriver[];
  }[];
  equityAfter: number;
  earningsAffected: string[];
  /** 下一轮预告（正常与 dry-run 都返回；只有非 dry-run 落库） */
  preview: Record<string, unknown>;
}

const utcToday = (): string => new Date().toISOString().slice(0, 10);
const isFriday = (date: string): boolean => new Date(date + "T00:00:00Z").getUTCDay() === 5;

/**
 * 财报日 CSV（data/earnings/{TICKER}.csv，date,value 格式）导入 DB。
 * 每次运行都做幂等 upsert（每季仅约 12 条/标的）：若只在空表时导入，
 * Actions 后续同步来的新财报日就永远进不了执行器。
 */
async function importEarningsCsvs(): Promise<number> {
  const dir = "data/earnings";
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".csv")) continue;
    const ticker = f.replace(".csv", "").toUpperCase();
    const points = parseFredCsv(readFileSync(`${dir}/${f}`, "utf8"));
    if (!points.length) continue;
    await upsertEarningsDates(points.map((p: Point) => ({ ticker, date: p.date })));
    total += points.length;
  }
  return total;
}

export async function runOnce(cfg: ExecutorConfig): Promise<ExecutionSummary> {
  await initSchema();
  if (!cfg.dryRun) {
    const importedEarnings = await importEarningsCsvs();
    if (importedEarnings) console.log(`财报日历已从 CSV 导入 ${importedEarnings} 条`);
  }
  const asOf = utcToday();

  // 1) 体制引擎：FRED → 时间线 → 最新状态（含 Sahm 门），并与上一轮运行态比较得出"是否切换"
  const bundle = await fetchMacroBundle();
  const timeline = computeRegimeTimeline(bundle, cfg.regime);
  const regimePoint = timeline[timeline.length - 1];
  if (!regimePoint) throw new Error("体制时间线为空：宏观序列数据不足（每路需 ≥3 年历史）");
  const rp: RegimePoint = regimePoint;
  const calendarLag = Math.round(
    (Date.parse(bundle.trend.at(-1)?.date ?? regimePoint.date) - Date.parse(regimePoint.date)) / 86_400_000,
  );
  if (calendarLag > MAX_SERIES_LAG_DAYS) {
    throw new Error(
      `体制时间线最新点停在 ${regimePoint.date}，落后 SP500 日历 ${calendarLag} 天——序列重叠不足以填满 ${WARMUP_DAYS} 天预热窗口`,
    );
  }
  const prevState = await loadRuntimeState(cfg.mode);
  const regimeChanged = prevState !== null && prevState.equityTarget !== regimePoint.equityTarget;
  const retarget = prevState !== null && cfg.configSig !== undefined && (prevState.sig ?? null) !== cfg.configSig;

  // 2) 叠加层：波动率目标乘数（近 22 日收盘）+ 估值锚偏移（CAPE 月度）
  let volMult: number | undefined;
  if (cfg.volTarget.enabled) {
    const since = new Date(Date.parse(asOf) - (cfg.volTarget.lookbackDays + 30) * 86_400_000).toISOString().slice(0, 10);
    const closesMap = await usClosesByTicker(cfg.tickers, since);
    const arrays = new Map<string, number[]>(
      [...closesMap].map(([t, m]) => [t, [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)]),
    );
    volMult = latestVolMultiplier(arrays, cfg.volTarget);
  }
  const tilt = cfg.valuation.enabled ? latestValuationTilt(loadCape(), cfg.valuation) : undefined;
  const composedEquityTarget = composeEquityTarget(regimePoint.equityTarget, volMult, tilt);
  if (regimePoint.gateActive) {
    // Sahm 门已在时间线内把 regime 目标压回 risk-off 档；这里只透传，不重复处理
  }

  // 3) 价格与组合状态
  const prices = await latestPrices(cfg.tickers);
  for (const t of cfg.tickers) {
    if (!prices.get(t)) throw new Error(`缺少 ${t} 的最新价格——先运行 GitHub Actions 同步或 python scripts/sync-prices.py`);
  }
  const { positions, cash } = await loadPortfolio(cfg.mode);
  let workingCash = cash;
  let seeded = false;
  if (positions.size === 0 && cash === 0) {
    workingCash = cfg.startCash; // 首次运行：注入初始资金
    seeded = true;
  }

  // 3.5) 现金计息：以上一轮决策日到今天的日历天数计（跨周末照常计息，上限 10 天防长停后一次性补太多）
  let cashInterestUsd = 0;
  if (cfg.cashInterest && prevState && workingCash > 0) {
    const rateSeries = bundle.cash ?? [];
    const rate = [...rateSeries].reverse().find((p) => p.date <= asOf)?.value;
    const days = Math.min(10, Math.max(0, Math.round((Date.parse(asOf) - Date.parse(prevState.asOf)) / 86_400_000)));
    if (rate !== undefined && days > 0) {
      cashInterestUsd = (workingCash * rate) / 100 / 365 * days;
      workingCash += cashInterestUsd;
    }
  }

  const priceOf = (t: string): number => prices.get(t) as number;
  const equityOf = (p: Map<string, number>, c: number): number => {
    let v = c;
    for (const [t, u] of p) v += u * priceOf(t);
    return v;
  };

  // 4) 定投引擎：仅周五注入，且当日未重复（以 dca 驱动标记去重）
  let dcaApplied = false;
  if (cfg.dcaUsdt > 0 && isFriday(asOf)) {
    const { rows } = await getPool().query<{ n: string }>(
      "select count(*)::text as n from trades where mode = $1 and reason like '%dca%' and date = $2",
      [cfg.mode, asOf],
    );
    if ((rows[0]?.n ?? "0") === "0") {
      workingCash += cfg.dcaUsdt;
      dcaApplied = true;
    }
  }

  // 5) 财报引擎：临近财报（前 N 天~后 M 天）的个股目标权重乘以缩放系数，余额留在现金筒
  const earningsAffected: string[] = [];
  const scaleOf = new Map<string, number>(cfg.tickers.map((t) => [t, 1]));
  const upcoming = await upcomingEarnings(cfg.tickers, asOf);
  if (cfg.earnings.enabled) {
    const afterDays = cfg.earnings.restoreDaysAfter;
    for (const t of cfg.tickers) {
      for (const d of upcoming.get(t) ?? []) {
        const diffDays = Math.round((Date.parse(d) - Date.parse(asOf)) / 86_400_000);
        if (diffDays <= cfg.earnings.riskOffDaysBefore && diffDays >= -afterDays) {
          scaleOf.set(t, cfg.earnings.scaleFactor);
          earningsAffected.push(t);
          break;
        }
      }
    }
  }

  // 6) 目标权重表：三层合成的股票仓位等权分到个股，财报引擎逐股缩放，余量归现金
  const equityBefore = equityOf(positions, workingCash);
  const perTicker = composedEquityTarget / cfg.tickers.length;
  const targetWeights: Record<string, number> = {};
  for (const t of cfg.tickers) targetWeights[t] = equityBefore > 0 ? perTicker * (scaleOf.get(t) ?? 1) : 0;

  // 逐笔成本：ADV20 可得则半价差+冲击，否则退回 slippagePercent
  const adv = await latestAdv(cfg.tickers);
  const costRateOf = (t: string, notional: number): number => {
    const a = adv.get(t);
    let bps = a !== undefined && a > 0 ? cfg.cost.halfSpreadBps + cfg.cost.impactCoef * Math.sqrt(notional / a) * 10_000 : cfg.slippagePercent * 100;
    if ((scaleOf.get(t) ?? 1) !== 1) bps *= cfg.cost.earningsMult;
    return bps / 10_000;
  };

  if (equityBefore <= 0) {
    const preview = buildPreview();
    if (!cfg.dryRun) {
      await savePortfolio(cfg.mode, positions, 0);
      await saveRuntimeState(cfg.mode, { regime: regimePoint.regime, equityTarget: regimePoint.equityTarget, score: regimePoint.score, asOf, sig: cfg.configSig });
      await saveExecutorPreview(cfg.mode, preview);
    }
    return {
      asOf,
      regime: regimePoint,
      prices,
      portfolioBefore: { cash, positions },
      equityBefore: 0,
      targetWeights,
      composedEquityTarget,
      composition: { regimeTarget: regimePoint.equityTarget, volMult, tilt },
      cashInterestUsd,
      trades: [],
      equityAfter: 0,
      earningsAffected: [...new Set(earningsAffected)],
      preview,
    };
  }

  // 7) 触发判断：定注入金 / 首次建仓 / 体制切换 / 任一标的漂移超阈值
  const driftOf = (t: string): number => {
    const px = priceOf(t);
    const w = px > 0 && equityBefore > 0 ? ((positions.get(t) ?? 0) * px) / equityBefore : 0;
    return (w - (targetWeights[t] ?? 0)) * 100;
  };
  const drifted = new Set(cfg.tickers.filter((t) => Math.abs(driftOf(t)) > cfg.driftThresholdPp));
  // 首轮建仓的空仓会让每只标的"偏离"满额目标权重，那是建仓的必然结果而非漂移引擎的
  // 独立判断——同时记两个驱动等于把同一件事归因两次。
  if (seeded) drifted.clear();

  // 批次级驱动：一笔调仓可由多个引擎同时触发，归因必须全部记录
  const batchDrivers: TradeDriver[] = [];
  if (seeded) batchDrivers.push("seed");
  if (dcaApplied) batchDrivers.push("dca");
  if (regimeChanged) batchDrivers.push("regime");
  if (retarget && !seeded) batchDrivers.push("retarget");
  if (drifted.size) batchDrivers.push("drift");

  const trades: ExecutionSummary["trades"] = [];
  if (batchDrivers.length) {
    const plan = cfg.tickers.map((t) => {
      const px = priceOf(t);
      const targetUnits = (equityBefore * (targetWeights[t] ?? 0)) / px;
      const delta = targetUnits - (positions.get(t) ?? 0);
      return { t, px, delta, notional: Math.abs(delta) * px };
    });
    const driversFor = (t: string): TradeDriver[] => [
      ...batchDrivers,
      ...(scaleOf.get(t) !== 1 && !batchDrivers.includes("earnings") ? (["earnings"] as TradeDriver[]) : []),
    ];

    // 先卖后买：卖出释放的现金可立即用于买入；买入受可用现金硬约束（含成本），杜绝负现金
    const execute = (p: { t: string; px: number; delta: number; notional: number }, buying: boolean) => {
      if (buying) {
        const rate = costRateOf(p.t, Math.min(p.notional, workingCash));
        const notional = Math.min(p.notional, workingCash / (1 + rate));
        if (notional * (1 + rate) < cfg.minTradeUsdt) return;
        const cost = notional * rate;
        const delta = notional / p.px;
        workingCash -= notional * (1 + rate);
        positions.set(p.t, (positions.get(p.t) ?? 0) + delta);
        trades.push({ date: asOf, ticker: p.t, unitsDelta: delta, notionalUsdt: notional, costUsd: cost, drivers: driversFor(p.t) });
        return;
      }
      if (p.notional < cfg.minTradeUsdt) return;
      const rate = costRateOf(p.t, p.notional);
      const cost = p.notional * rate;
      workingCash += p.notional * (1 - rate);
      positions.set(p.t, (positions.get(p.t) ?? 0) + p.delta);
      trades.push({ date: asOf, ticker: p.t, unitsDelta: p.delta, notionalUsdt: p.notional, costUsd: cost, drivers: driversFor(p.t) });
    };

    for (const p of plan.filter((x) => x.delta < 0)) execute(p, false);
    for (const p of plan.filter((x) => x.delta > 0)) execute(p, true);
  }

  const preview = buildPreview();

  // 8) 持久化（dry-run 全跳过）
  if (!cfg.dryRun) {
    await savePortfolio(cfg.mode, positions, workingCash);
    await saveRuntimeState(cfg.mode, { regime: regimePoint.regime, equityTarget: regimePoint.equityTarget, score: regimePoint.score, asOf, sig: cfg.configSig });
    if (trades.length) await recordTrades(cfg.mode, trades);
    await saveExecutorPreview(cfg.mode, preview);
  }

  return {
    asOf,
    regime: regimePoint,
    prices,
    portfolioBefore: { cash, positions },
    equityBefore,
    targetWeights,
    composedEquityTarget,
    composition: { regimeTarget: regimePoint.equityTarget, volMult, tilt },
    cashInterestUsd,
    trades,
    equityAfter: equityOf(positions, workingCash),
    earningsAffected: [...new Set(earningsAffected)],
    preview,
  };

  /** 下一轮预告：确定性规则可提前算出"下一轮会做什么"（dry-run 也返回） */
  function buildPreview(): Record<string, unknown> {
    const nextFriday = (() => {
      const now = new Date();
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
      return d.toISOString().slice(0, 10);
    })();
    const eq = equityOf(positions, workingCash);
    // 下周五定投按当期目标权重分摊（财报窗口内的标的按缩放后权重）
    const weights = cfg.tickers.map((t) => perTicker * (scaleOf.get(t) ?? 1));
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;
    const plannedDca = cfg.tickers.map((t, i) => ({
      ticker: t,
      usdt: Math.round(((cfg.dcaUsdt * (weights[i] as number)) / wSum) * 100) / 100,
    }));
    const drifts = cfg.tickers.map((t) => ({
      ticker: t,
      driftPp: Math.round(driftOfSafe(t) * 100) / 100,
      thresholdPp: cfg.driftThresholdPp,
    }));
    const earningsNext14d: { ticker: string; date: string }[] = [];
    for (const t of cfg.tickers) {
      for (const d of upcoming.get(t) ?? []) {
        const diff = Math.round((Date.parse(d) - Date.parse(asOf)) / 86_400_000);
        if (diff >= 0 && diff <= 14) earningsNext14d.push({ ticker: t, date: d });
      }
    }
    return {
      asOf,
      regime: rp.regime,
      score: Math.round(rp.score * 1000) / 1000,
      sahm: rp.sahm,
      gateActive: rp.gateActive,
      composition: {
        regimeTarget: rp.equityTarget,
        volMult: volMult ?? null,
        tilt: tilt ?? null,
        final: Math.round(composedEquityTarget * 10000) / 10000,
      },
      equity: Math.round(eq * 100) / 100,
      drifts,
      nextFriday: cfg.dcaUsdt > 0 ? { date: nextFriday, injectionUsdt: cfg.dcaUsdt, planned: plannedDca } : null,
      earningsNext14d,
    };
  }

  // 预告里的漂移：组合未变时与上面 driftOf 相同；组合已按本轮成交更新后，预告反映"若现在就是下一轮"
  function driftOfSafe(t: string): number {
    const px = priceOf(t);
    const eq = equityOf(positions, workingCash);
    const w = px > 0 && eq > 0 ? ((positions.get(t) ?? 0) * px) / eq : 0;
    const tgt = perTicker * (scaleOf.get(t) ?? 1);
    return (w - tgt) * 100;
  }
}
