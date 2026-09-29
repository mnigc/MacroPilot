/**
 * 仪表盘与策略引擎页共用的状态计算。
 * 六引擎读数、体制边缘、财报窗口、持仓偏离都在这里现算、两个页面各取所需，
 * 避免"同源数据两处算"将来跑出两套口径。全部是实测读数，没有一项是估算。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  getArtifact,
  getEarningsCoverage,
  getExecutorPreview,
  getLatestRun,
  getNextEarnings,
  getPortfolio,
  getRegimePoints,
  getTickerBoard,
  getTrades,
} from "./db";
import { parseDrivers } from "./drivers";

export const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const fmtPct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** 状态行里的数字加粗：string 是说明文字，{b} 是读数 */
export type Tok = string | { b: string; cls?: string };

export async function getEngineState() {
  const cfg = JSON.parse(readFileSync("../config/strategy.json", "utf8")) as {
    engines: {
      dca: { amountUsdt: number };
      regime: { scoreHigh: number; scoreLow: number; scoreRelease: number; allocation: Record<string, number>; gate?: { sahmThreshold: number }; signals: Record<string, { weight: number }> };
      volTarget?: { targetVol: number };
      drift: { thresholdPp: number };
      earnings: { riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
    };
    execution: { startCashUsdt: number };
  };

  const run = await getLatestRun();
  const tickers: string[] = run?.tickers ?? [];
  const regimePoints = run ? await getRegimePoints(run.id) : [];
  const latest = regimePoints.at(-1) ?? null;

  const [board, portfolio, paperTrades, cover, nextEarn, preview, analog] = await Promise.all([
    getTickerBoard(tickers),
    getPortfolio("paper"),
    // 全量取：定投次数、累计买卖等统计不能被 limit 悄悄截断；展示侧自行 slice
    getTrades("paper"),
    getEarningsCoverage(tickers),
    getNextEarnings(tickers),
    getExecutorPreview("paper"),
    run
      ? getArtifact<{ windows: { start: string; end: string; distance: number; fwd63: number | null; fwd126: number | null; fwd252: number | null }[]; asOf: string | null; note: string }>(run.id, "analog")
      : Promise.resolve(null),
  ]);
  /** 估值锚引擎的数据源是否在位（sync-valuation.py 的产物） */
  const capeReady = existsSync("../data/valuation/cape.csv");

  const px = Object.fromEntries(board.map((b) => [b.ticker, b]));
  const cash = portfolio.find((p) => p.ticker === "CASH")?.units ?? 0;
  const holdings = portfolio.filter((p) => p.ticker !== "CASH");
  /** 持仓中拿不到最新行情的标的：按 0 计会静默低估净值，必须显式标出来 */
  const missingPx = holdings.filter((p) => !px[p.ticker]?.close).map((p) => p.ticker);
  const equity = cash + holdings.reduce((a, p) => a + p.units * (px[p.ticker]?.close ?? 0), 0);
  const startCash = cfg.execution.startCashUsdt;
  const pnl = equity > 0 ? equity / startCash - 1 : 0;
  const cashWeight = equity > 0 ? cash / equity : 0;
  const cashTarget = latest ? 1 - latest.equity_target : 0;

  const e = cfg.engines;
  const targetEach = latest ? latest.equity_target / (tickers.length || 1) : 0;
  /** 财报窗口内的标的：前 riskOffDaysBefore 天 ~ 后 restoreDaysAfter 天，目标权重减半 */
  const earnWindow = new Map(nextEarn.map((n) => [n.ticker, n]));
  const inWindow = (t: string) => {
    const n = earnWindow.get(t);
    return !!n && n.daysAway <= e.earnings.riskOffDaysBefore && n.daysAway >= -e.earnings.restoreDaysAfter;
  };
  const targetOf = (t: string) => targetEach * (inWindow(t) ? e.earnings.scaleFactor : 1);

  const rows = holdings
    .map((p) => {
      const b = px[p.ticker];
      const value = p.units * (b?.close ?? 0);
      const weight = equity > 0 ? value / equity : 0;
      const tgt = targetOf(p.ticker);
      return { ticker: p.ticker, units: p.units, close: b?.close ?? 0, value, weight, tgt, drift: (weight - tgt) * 100, b };
    })
    .sort((a, b) => b.value - a.value);
  const maxDrift = rows.reduce((m, r) => Math.max(m, Math.abs(r.drift)), 0);
  const drifted = rows.filter((r) => Math.abs(r.drift) > e.drift.thresholdPp).length;

  const nextEarnLabel = nextEarn[0] ? `${nextEarn[0].ticker} T-${nextEarn[0].daysAway}` : "—";

  const nextFriday = (() => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    return d.toISOString().slice(0, 10);
  })();
  const dcaCount = paperTrades.filter((t) => parseDrivers(t.reason).includes("dca")).length;

  /** 综合分到最近一次切换的边沿距离——"引擎现在离动作有多远" */
  const score = latest?.score ?? 0;
  const regime = latest?.regime ?? "neutral";
  /** 距下一次体制切换的"余量"：极态看回落内沿，中性看最近的外沿。正数=还有距离 */
  const edge = (() => {
    if (regime === "riskOn") return { label: "距跌回中性", v: score - e.regime.scoreRelease };
    if (regime === "riskOff") return { label: "距爬回中性", v: e.regime.scoreRelease - score };
    const up = e.regime.scoreHigh - score;
    const down = score - e.regime.scoreLow;
    return up <= down ? { label: "距 risk-on", v: up } : { label: "距 risk-off", v: down };
  })();
  const switches90 = (() => {
    const cut = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (let i = 1; i < regimePoints.length; i++) {
      if (regimePoints[i].date < cut) continue;
      if (regimePoints[i].regime !== regimePoints[i - 1].regime) n++;
    }
    return n;
  })();

  const volMultNow = preview?.composition.volMult ?? null;
  const tiltNow = preview?.composition.tilt ?? null;

  return {
    cfg,
    e,
    run,
    tickers,
    regimePoints,
    latest,
    board,
    cover,
    nextEarn,
    earnWindow,
    inWindow,
    paperTrades,
    preview,
    analog,
    capeReady,
    missingPx,
    cash,
    cashWeight,
    cashTarget,
    equity,
    startCash,
    pnl,
    targetEach,
    rows,
    maxDrift,
    drifted,
    nextEarnLabel,
    nextFriday,
    dcaCount,
    score,
    regime,
    edge,
    switches90,
    volMultNow,
    tiltNow,
  };
}
