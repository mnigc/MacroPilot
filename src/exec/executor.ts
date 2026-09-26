import { fetchMacroBundle } from "../data/fred.js";
import { computeRegimeTimeline, type RegimeConfig, type RegimePoint } from "../strategy/regime.js";
import type { TradeDriver } from "../strategy/drivers.js";
import {
  initSchema,
  latestPrices,
  latestPremiums,
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
 * paper 的成交价 = 最近同步收盘价 × (1 + 链上可成交溢价)：钱确实按链上价付出去，持仓却仍按
 * 收盘参考价估值。两者之差就是"在链上买美股的真实摩擦"，它会原样留在净值曲线里，
 * 而不是被折进 slippagePercent 那个笼统的执行成本假设。目标权重与漂移仍按参考价计算，
 * 因此四引擎的决策与回测（run #14）完全可比，差异只出现在成交执行这一层。
 * live 模式把每笔差额交给 trader（RFQ 链路，见 src/exec/live.ts），真实成交价里本就含溢价。
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
  /** 本轮采用的溢价快照时刻；null = 表里没有可用快照，成交退化为纯参考价 */
  premiumAsOf: string | null;
  premiums: Map<string, number>;
  portfolioBefore: { cash: number; positions: Map<string, number> };
  equityBefore: number;
  targetWeights: Record<string, number>;
  trades: {
    date: string;
    ticker: string;
    unitsDelta: number;
    notionalUsdt: number;
    drivers: TradeDriver[];
    txHash?: string;
    /** 这笔成交计入了多少溢价；live 成交由真实报价决定，记 null */
    premium: number | null;
  }[];
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
  const isLive = cfg.mode === "live";
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
  // 模拟成交（paper，以及任何试运行用的 mode）按"收盘价 × (1+溢价)"计价；
  // live 的成交价来自真实报价，溢价本就含在里面
  const snapshot = !isLive ? await latestPremiums(cfg.tickers) : { capturedAt: null, premiums: new Map<string, number>() };
  const { positions, cash } = await loadPortfolio(cfg.mode);
  let workingCash = cash;
  let seeded = false;
  if (positions.size === 0 && cash === 0) {
    workingCash = cfg.startCash; // 首次运行：注入初始资金
    seeded = true;
  }

  const priceOf = (t: string): number => prices.get(t) as number;
  /** 本轮的真实付出/所得单价：参考价之上叠加链上溢价 */
  const execPriceOf = (t: string): number => priceOf(t) * (1 + (snapshot.premiums.get(t) ?? 0));
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
      premiumAsOf: snapshot.capturedAt,
      premiums: snapshot.premiums,
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
  // 首轮建仓的空仓会让每只标的"偏离"满额目标权重，那是建仓的必然结果而非漂移引擎的
  // 独立判断——同时记两个驱动等于把同一件事归因两次。
  if (seeded) drifted.clear();

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
      const exec = execPriceOf(t);
      const targetUnits = (equityBefore * (targetWeights[t] ?? 0)) / px;
      const delta = targetUnits - (positions.get(t) ?? 0);
      // 目标股数仍按参考价求（决策口径与回测一致），名义额按链上有效价结算（执行口径）
      return { t, exec, delta, notional: Math.abs(delta) * exec };
    });
    const driversFor = (t: string): TradeDriver[] => [
      ...batchDrivers,
      ...(scaleOf.get(t) !== 1 && !batchDrivers.includes("earnings") ? (["earnings"] as TradeDriver[]) : []),
    ];

    // 先卖后买：卖出释放的现金可立即用于买入；买入受可用现金硬约束（含成本），杜绝负现金
    const execute = async (p: { t: string; exec: number; delta: number; notional: number }, buying: boolean) => {
      // live 的 snapshot.premiums 恒为空（真实报价里已含溢价），所以这一项天然只在 paper 有值
      const prem = snapshot.premiums.get(p.t) ?? null;
      if (buying) {
        const notional = Math.min(p.notional, workingCash / (1 + feeRate));
        if (notional * (1 + feeRate) < cfg.minTradeUsdt) return;
        const delta = notional / p.exec;
        if (isLive) {
          const fill = await cfg.trader!.fill({ ticker: p.t, side: "buy", notionalUsdt: notional });
          workingCash -= fill.units * fill.price * (1 + feeRate);
          positions.set(p.t, (positions.get(p.t) ?? 0) + fill.units);
          trades.push({ date: asOf, ticker: p.t, unitsDelta: fill.units, notionalUsdt: fill.units * fill.price, drivers: driversFor(p.t), txHash: fill.txHash, premium: null });
          return;
        }
        workingCash -= notional * (1 + feeRate);
        positions.set(p.t, (positions.get(p.t) ?? 0) + delta);
        trades.push({ date: asOf, ticker: p.t, unitsDelta: delta, notionalUsdt: notional, drivers: driversFor(p.t), premium: prem });
        return;
      }
      if (p.notional < cfg.minTradeUsdt) return;
      if (isLive) {
        const fill = await cfg.trader!.fill({ ticker: p.t, side: "sell", notionalUsdt: p.notional });
        workingCash += fill.units * fill.price * (1 - feeRate);
        positions.set(p.t, (positions.get(p.t) ?? 0) - fill.units);
        trades.push({ date: asOf, ticker: p.t, unitsDelta: -fill.units, notionalUsdt: fill.units * fill.price, drivers: driversFor(p.t), txHash: fill.txHash, premium: null });
        return;
      }
      workingCash += p.notional * (1 - feeRate);
      positions.set(p.t, (positions.get(p.t) ?? 0) + p.delta);
      trades.push({ date: asOf, ticker: p.t, unitsDelta: p.delta, notionalUsdt: p.notional, drivers: driversFor(p.t), premium: prem });
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
    premiumAsOf: snapshot.capturedAt,
    premiums: snapshot.premiums,
    portfolioBefore: { cash, positions },
    equityBefore,
    targetWeights,
    trades,
    equityAfter: equityOf(positions, workingCash),
    earningsAffected: [...new Set(earningsAffected)],
  };
}
