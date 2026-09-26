import { fetchMacroBundle } from "../data/fred.js";
import { computeRegimeTimeline, type RegimeConfig, type RegimePoint } from "../strategy/regime.js";
import type { TradeDriver } from "../strategy/drivers.js";
import {
  initSchema,
  latestPrices,
  loadPortfolio,
  loadRuntimeState,
  recordTrades,
  savePortfolio,
  saveRuntimeState,
  upcomingEarnings,
  upsertEarningsDates,
  getPool,
} from "../db/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseFredCsv } from "../data/stats.js";
import type { Point } from "../data/stats.js";

/**
 * 执行器：四引擎（定投/体制/漂移/财报）→ 一张目标权重表 → 与当前组合求差额 → 交易。
 *
 * paper 模式以 DB 中最近同步的收盘价成交，并按 slippagePercent 计提成本（与回测同一套
 * 现金约束）；live 模式把每笔差额交给 trader（RFQ 链路，见 src/exec/live.ts）。
 * 财报引擎只在执行器生效：历史财报日无法免费回溯 6.5 年，回测中关闭。
 */

/** live 模式下由外部提供的成交实现；paper 模式不需要 */
export interface Trader {
  /** 以 notionalUsdt 买入/卖出 ticker，返回实际成交数量与均价 */
  fill(order: { ticker: string; side: "buy" | "sell"; notionalUsdt: number }): Promise<{ units: number; price: number; txHash?: string }>;
}

export interface ExecutorConfig {
  tickers: string[];
  mode: "paper" | "live";
  startCash: number;
  dcaUsdt: number;
  driftThresholdPp: number;
  minTradeUsdt: number;
  /** 预期单边成本（百分比，滑点+价差+gas 的合计近似），paper 记账与 live 护栏共用 */
  slippagePercent: number;
  regime: RegimeConfig;
  earnings: { enabled: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
  /** mode=live 必需 */
  trader?: Trader;
}

export interface ExecutionSummary {
  asOf: string;
  regime: RegimePoint;
  prices: Map<string, number>;
  portfolioBefore: { cash: number; positions: Map<string, number> };
  equityBefore: number;
  targetWeights: Record<string, number>;
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; drivers: TradeDriver[]; txHash?: string }[];
  equityAfter: number;
  earningsAffected: string[];
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
  if (cfg.mode === "live" && !cfg.trader) throw new Error("live 模式必须提供 trader（见 src/exec/live.ts）");
  const feeRate = cfg.slippagePercent / 100;
  await initSchema();
  const importedEarnings = await importEarningsCsvs();
  if (importedEarnings) console.log(`财报日历已从 CSV 导入 ${importedEarnings} 条`);
  const asOf = utcToday();

  // 1) 体制引擎：FRED → 时间线 → 最新状态，并与上一轮运行态比较得出"是否切换"
  const bundle = await fetchMacroBundle();
  const timeline = computeRegimeTimeline(bundle, cfg.regime);
  const regimePoint = timeline[timeline.length - 1];
  if (!regimePoint) throw new Error("体制时间线为空：宏观序列数据不足（需 ≥3 年历史）");
  const prevState = await loadRuntimeState(cfg.mode);
  const regimeChanged = prevState !== null && prevState.equityTarget !== regimePoint.equityTarget;

  // 2) 价格与组合状态
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

  const priceOf = (t: string): number => prices.get(t) as number;
  const equityOf = (p: Map<string, number>, c: number): number => {
    let v = c;
    for (const [t, u] of p) v += u * priceOf(t);
    return v;
  };

  // 3) 定投引擎：仅周五注入，且当日未重复（以 dca 驱动标记去重）
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

  // 4) 财报引擎：临近财报（前 N 天~后 M 天）的个股目标权重乘以缩放系数，余额留在现金筒
  const earningsAffected: string[] = [];
  const scaleOf = new Map<string, number>(cfg.tickers.map((t) => [t, 1]));
  if (cfg.earnings.enabled) {
    const upcoming = await upcomingEarnings(cfg.tickers, asOf);
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

  // 5) 目标权重表：体制决定总股票仓位，等权分到个股，财报引擎逐股缩放，余量归现金
  const equityBefore = equityOf(positions, workingCash);
  const perTicker = regimePoint.equityTarget / cfg.tickers.length;
  const targetWeights: Record<string, number> = {};
  for (const t of cfg.tickers) targetWeights[t] = equityBefore > 0 ? perTicker * (scaleOf.get(t) ?? 1) : 0;

  if (equityBefore <= 0) {
    // 空组合且零现金：只记录状态，不交易
    await savePortfolio(cfg.mode, positions, 0);
    await saveRuntimeState(cfg.mode, { regime: regimePoint.regime, equityTarget: regimePoint.equityTarget, score: regimePoint.score, asOf });
    return {
      asOf,
      regime: regimePoint,
      prices,
      portfolioBefore: { cash, positions },
      equityBefore: 0,
      targetWeights,
      trades: [],
      equityAfter: 0,
      earningsAffected: [...new Set(earningsAffected)],
    };
  }

  // 6) 触发判断：定注入金 / 首次建仓 / 体制切换 / 任一标的漂移超阈值
  const driftOf = (t: string): number => {
    const px = priceOf(t);
    const w = px > 0 && equityBefore > 0 ? ((positions.get(t) ?? 0) * px) / equityBefore : 0;
    return (w - (targetWeights[t] ?? 0)) * 100;
  };
  const drifted = new Set(cfg.tickers.filter((t) => Math.abs(driftOf(t)) > cfg.driftThresholdPp));

  // 批次级驱动：一笔调仓可由多个引擎同时触发，归因必须全部记录
  const batchDrivers: TradeDriver[] = [];
  if (seeded) batchDrivers.push("seed");
  if (dcaApplied) batchDrivers.push("dca");
  if (regimeChanged) batchDrivers.push("regime");
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
    const execute = async (p: { t: string; px: number; delta: number; notional: number }, buying: boolean) => {
      if (buying) {
        const notional = Math.min(p.notional, workingCash / (1 + feeRate));
        if (notional * (1 + feeRate) < cfg.minTradeUsdt) return;
        const delta = notional / p.px;
        if (cfg.mode === "live") {
          const fill = await cfg.trader!.fill({ ticker: p.t, side: "buy", notionalUsdt: notional });
          workingCash -= fill.units * fill.price * (1 + feeRate);
          positions.set(p.t, (positions.get(p.t) ?? 0) + fill.units);
          trades.push({ date: asOf, ticker: p.t, unitsDelta: fill.units, notionalUsdt: fill.units * fill.price, drivers: driversFor(p.t), txHash: fill.txHash });
          return;
        }
        workingCash -= notional * (1 + feeRate);
        positions.set(p.t, (positions.get(p.t) ?? 0) + delta);
        trades.push({ date: asOf, ticker: p.t, unitsDelta: delta, notionalUsdt: notional, drivers: driversFor(p.t) });
        return;
      }
      if (p.notional < cfg.minTradeUsdt) return;
      if (cfg.mode === "live") {
        const fill = await cfg.trader!.fill({ ticker: p.t, side: "sell", notionalUsdt: p.notional });
        workingCash += fill.units * fill.price * (1 - feeRate);
        positions.set(p.t, (positions.get(p.t) ?? 0) - fill.units);
        trades.push({ date: asOf, ticker: p.t, unitsDelta: -fill.units, notionalUsdt: fill.units * fill.price, drivers: driversFor(p.t), txHash: fill.txHash });
        return;
      }
      workingCash += p.notional * (1 - feeRate);
      positions.set(p.t, (positions.get(p.t) ?? 0) + p.delta);
      trades.push({ date: asOf, ticker: p.t, unitsDelta: p.delta, notionalUsdt: p.notional, drivers: driversFor(p.t) });
    };

    for (const p of plan.filter((x) => x.delta < 0)) await execute(p, false);
    for (const p of plan.filter((x) => x.delta > 0)) await execute(p, true);
  }

  // 7) 持久化
  await savePortfolio(cfg.mode, positions, workingCash);
  await saveRuntimeState(cfg.mode, { regime: regimePoint.regime, equityTarget: regimePoint.equityTarget, score: regimePoint.score, asOf });
  if (trades.length) await recordTrades(cfg.mode, trades);

  return {
    asOf,
    regime: regimePoint,
    prices,
    portfolioBefore: { cash, positions },
    equityBefore,
    targetWeights,
    trades,
    equityAfter: equityOf(positions, workingCash),
    earningsAffected: [...new Set(earningsAffected)],
  };
}
