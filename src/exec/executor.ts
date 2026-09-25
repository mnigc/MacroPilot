import { fetchMacroBundle } from "../data/fred.js";
import { computeRegimeTimeline, type RegimeConfig, type RegimePoint } from "../strategy/regime.js";
import {
  initSchema,
  latestPrices,
  loadPortfolio,
  recordTrades,
  savePortfolio,
  upcomingEarnings,
  upsertEarningsDates,
  getPool,
} from "../db/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseFredCsv } from "../data/stats.js";
import type { Point } from "../data/stats.js";

/** 财报日 CSV（data/earnings/{TICKER}.csv，date,value 格式）导入 DB；表为空时执行 */
async function importEarningsCsvs(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>("select count(*)::text as n from earnings_dates");
  if ((rows[0]?.n ?? "0") !== "0") return 0;
  const dir = "data/earnings";
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".csv")) continue;
    const ticker = f.replace(".csv", "").toUpperCase();
    const points = parseFredCsv(readFileSync(`${dir}/${f}`, "utf8"));
    await upsertEarningsDates(points.map((p: Point) => ({ ticker, date: p.date })));
    total += points.length;
  }
  return total;
}

/**
 * 执行器：四引擎（定投/体制/漂移/财报）→ 一张目标权重表 → 与当前组合求差额 → 交易。
 *
 * paper 模式以 DB 中最近同步的收盘价成交（零滑点零手续费，真实成交需 API key 后走
 * RFQ 链路）。财报引擎只在执行器生效：历史财报日无法免费回溯 6.5 年，回测中关闭。
 */

export interface ExecutorConfig {
  tickers: string[];
  mode: "paper" | "live";
  startCash: number;
  dcaUsdt: number;
  driftThresholdPp: number;
  minTradeUsdt: number;
  regime: RegimeConfig;
  earnings: { enabled: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
}

export interface ExecutionSummary {
  asOf: string;
  regime: RegimePoint;
  prices: Map<string, number>;
  portfolioBefore: { cash: number; positions: Map<string, number> };
  equityBefore: number;
  targetWeights: Record<string, number>;
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; reason: string }[];
  equityAfter: number;
  earningsAffected: string[];
}

const utcToday = (): string => new Date().toISOString().slice(0, 10);
const isFriday = (date: string): boolean => new Date(date + "T00:00:00Z").getUTCDay() === 5;

export async function runOnce(cfg: ExecutorConfig): Promise<ExecutionSummary> {
  await initSchema();
  const importedEarnings = await importEarningsCsvs();
  if (importedEarnings) console.log(`财报日历已从 CSV 导入 ${importedEarnings} 条`);
  const asOf = utcToday();

  // 1) 体制引擎：FRED → 时间线 → 最新状态
  const bundle = await fetchMacroBundle();
  const timeline = computeRegimeTimeline(bundle, cfg.regime);
  const regimePoint = timeline[timeline.length - 1];
  if (!regimePoint) throw new Error("体制时间线为空：宏观序列数据不足（需 ≥3 年历史）");

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

  // 3) 定投引擎：仅周五注入，且当日未重复（以 dca 交易记录去重）
  let dcaApplied = false;
  if (cfg.dcaUsdt > 0 && isFriday(asOf)) {
    const { rows } = await getPool().query<{ n: string }>(
      "select count(*)::text as n from trades where mode = $1 and reason = 'dca' and date = $2",
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
      const dates = upcoming.get(t) ?? [];
      for (const d of dates) {
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
  const perTicker = (regimePoint.equityTarget / cfg.tickers.length);
  const targetWeights: Record<string, number> = {};
  let weightsSum = 0;
  for (const t of cfg.tickers) {
    targetWeights[t] = equityBefore > 0 ? perTicker * (scaleOf.get(t) ?? 1) : 0;
    weightsSum += targetWeights[t];
  }
  if (equityBefore <= 0) {
    // 空组合且零现金：只记录状态，不交易
    await savePortfolio(cfg.mode, positions, 0);
    return {
      asOf,
      regime: regimePoint,
      prices,
      portfolioBefore: { cash: cash, positions: positions },
      equityBefore: 0,
      targetWeights,
      trades: [],
      equityAfter: 0,
      earningsAffected,
    };
  }

  // 6) 触发判断：定注入金 / 首次建仓 / 任一标的漂移超阈值（含体制切换后的偏离）
  const weightOf = (t: string): number => {
    const units = positions.get(t) ?? 0;
    return (units * priceOf(t)) / equityBefore;
  };
  const driftExceeded = cfg.tickers.some((t) => {
    const w = targetWeights[t] ?? 0;
    return Math.abs(weightOf(t) - w) * 100 > cfg.driftThresholdPp;
  });
  const shouldRebalance = dcaApplied || driftExceeded || seeded;
  const reason: "dca" | "regime" | "drift" = seeded ? "regime" : dcaApplied ? "dca" : "drift";

  const trades: ExecutionSummary["trades"] = [];
  if (shouldRebalance) {
    const targetStockValue = equityBefore * weightsSum;
    for (const t of cfg.tickers) {
      const px = priceOf(t);
      const currentUnits = positions.get(t) ?? 0;
      const targetUnits = (targetStockValue * ((targetWeights[t] ?? 0) / (weightsSum || 1))) / px;
      const delta = targetUnits - currentUnits;
      const notional = Math.abs(delta) * px;
      if (notional < cfg.minTradeUsdt) continue;
      workingCash -= delta * px;
      positions.set(t, currentUnits + delta);
      trades.push({ date: asOf, ticker: t, unitsDelta: delta, notionalUsdt: notional, reason });
    }
  }

  // 7) 持久化
  await savePortfolio(cfg.mode, positions, workingCash);
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
