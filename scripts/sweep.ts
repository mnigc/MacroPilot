/**
 * 参数敏感性与 walk-forward：npm run sweep
 *
 * 回答两个"这份参数是规律还是巧合"的问题：
 *  1. 敏感性：在关键参数的邻域网格上跑完整回测——结论（夏普/回撤）若对 ±扰动 翻脸，
 *     就是过拟合的直接证据。落 run_artifacts(kind=sensitivity)。
 *  2. walk-forward：只用过去选参、在"未来"上验证——IS 选出的最优参数在 OOS 年份的
 *     实际表现，是策略可信度的试金石。落 run_artifacts(kind=walkforward)。
 *
 * 产物挂在最近一次 full 回测 run 上（先跑 npm run backtest 再跑本脚本）。
 */
import "dotenv/config";
import { loadStrategyFile, loadBacktestContext, regimeConfigOf, volTargetConfigOf } from "../src/backtest/context.js";
import { computeRegimeTimeline, type RegimePoint } from "../src/strategy/regime.js";
import { volMultiplierSeries } from "../src/strategy/overlays.js";
import { runBacktest, type EngineToggles } from "../src/backtest/engine.js";
import { computeMetrics } from "../src/backtest/metrics.js";
import { latestRunId, saveArtifacts, getPool } from "../src/db/index.js";
import type { Point } from "../src/data/stats.js";

const s = loadStrategyFile();
const ctx = await loadBacktestContext(s);
const baseRegime = regimeConfigOf(s);
const volCfg = volTargetConfigOf(s);
const tickers = [...ctx.closes.keys()];
const fullCalendar = ctx.bundle.trend.map((p) => p.date);

const ENGINES: EngineToggles = { dca: true, regime: true, volTarget: true, valuation: true, sentiment: true, drift: true, earnings: true };

const baseCfg = {
  tickers,
  startCash: s.execution.startCashUsdt ?? 10_000,
  dcaUsdt: s.engines.dca.amountUsdt,
  driftThresholdPp: s.engines.drift.thresholdPp,
  minTradeUsdt: s.execution.minTradeUsdt,
  cost: { ...(s.execution.cost ?? { halfSpreadBps: 3, impactCoef: 0.35, earningsMult: 1.5 }), flatBps: s.execution.slippagePercent * 100 },
  volTriggerPp: volCfg.triggerPp,
  valueTriggerPp: s.engines.valuation?.triggerPp ?? 5,
  sentTriggerPp: s.engines.sentiment?.triggerPp ?? 5,
  earnings: {
    daysBefore: s.engines.earnings.riskOffDaysBefore,
    daysAfter: s.engines.earnings.restoreDaysAfter,
    scale: s.engines.earnings.scaleFactor,
  },
  earningsByTicker: ctx.earningsByTicker,
  cashRate: ctx.bundle.cash,
  advDollars: ctx.advDollars,
};

/** 给定阈值组合重算时间线，并在其日历上重算波动率乘数 */
function buildTimeline(scoreHigh: number, scoreLow: number, targetVol: number): { timeline: RegimePoint[]; volMult: (number | undefined)[] } {
  const timeline = computeRegimeTimeline(ctx.bundle, { ...baseRegime, scoreHigh, scoreLow });
  const volFull = volMultiplierSeries(ctx.closes, fullCalendar, { ...volCfg, targetVol });
  const idxOf = new Map(fullCalendar.map((d, i) => [d, i]));
  const volMult = timeline.map((p) => volFull[idxOf.get(p.date) as number]);
  return { timeline, volMult };
}

function runOn(timeline: RegimePoint[], volMult: (number | undefined)[], driftPp = baseCfg.driftThresholdPp) {
  return runBacktest(ctx.closes, timeline, { ...baseCfg, engines: ENGINES, volMult, tilt: ctx.tilt, sentTilt: ctx.sentTilt, driftThresholdPp: driftPp });
}

const evalSharp = (timeline: RegimePoint[], volMult: (number | undefined)[], driftPp?: number, from?: string, to?: string) => {
  const result = runOn(timeline, volMult, driftPp);
  const slice = (xs: { date: string; value: number }[]) =>
    xs.filter((p) => (!from || p.date >= from) && (!to || p.date < to));
  return computeMetrics(slice(result.strategyEquity)).sharpe;
};

// ---- 1) 敏感性网格 ----
console.log("敏感性网格…");
const hs = [0.55, 0.6, 0.65];
const ls = [0.25, 0.3, 0.35];
const tvs = [0.12, 0.15, 0.18];
const dps = [3, 5, 8];

const gridA: { scoreHigh: number; scoreLow: number; sharpe: number; cagr: number; maxDd: number }[] = [];
for (const h of hs) {
  for (const l of ls) {
    const { timeline, volMult } = buildTimeline(h, l, volCfg.targetVol);
    const m = computeMetrics(runOn(timeline, volMult).strategyEquity);
    gridA.push({ scoreHigh: h, scoreLow: l, sharpe: m.sharpe, cagr: m.cagr, maxDd: m.maxDrawdown });
  }
}
const baseVolMult = ctx.volMult;
const gridB: { targetVol: number; driftPp: number; sharpe: number; cagr: number; maxDd: number }[] = [];
for (const tv of tvs) {
  for (const dp of dps) {
    const volFull = volMultiplierSeries(ctx.closes, fullCalendar, { ...volCfg, targetVol: tv });
    const idxOf = new Map(fullCalendar.map((d, i) => [d, i]));
    const volMult = ctx.timeline.map((p) => volFull[idxOf.get(p.date) as number]);
    const m = computeMetrics(runOn(ctx.timeline, volMult, dp).strategyEquity);
    gridB.push({ targetVol: tv, driftPp: dp, sharpe: m.sharpe, cagr: m.cagr, maxDd: m.maxDrawdown });
  }
}
console.log(`  阈值网格 ${gridA.length} 组 · 波动/漂移网格 ${gridB.length} 组`);
void baseVolMult;

// ---- 2) walk-forward：只用过去选参，在"未来"年份验证 ----
console.log("walk-forward…");
const combos: { scoreHigh: number; scoreLow: number; targetVol: number; timeline: RegimePoint[]; volMult: (number | undefined)[] }[] = [];
for (const h of hs) for (const l of ls) for (const tv of tvs) combos.push({ scoreHigh: h, scoreLow: l, targetVol: tv, ...buildTimeline(h, l, tv) });

const yearBounds = ["2023-01-01", "2024-01-01", "2025-01-01", "2026-01-01"];
const folds: {
  testYear: string;
  chosen: { scoreHigh: number; scoreLow: number; targetVol: number };
  isSharpe: number;
  oosSharpe: number;
  oosCagr: number;
  oosMaxDd: number;
  baselineOosSharpe: number;
}[] = [];
for (let i = 0; i < yearBounds.length; i++) {
  const trainTo = yearBounds[i] as string;
  const testTo = yearBounds[i + 1];
  let best: { combo: (typeof combos)[number]; sharpe: number } | null = null;
  for (const c of combos) {
    const is = evalSharp(c.timeline, c.volMult, undefined, undefined, trainTo);
    if (!best || is > best.sharpe) best = { combo: c, sharpe: is };
  }
  if (!best) continue;
  const oosResult = runOn(best.combo.timeline, best.combo.volMult);
  const oosMetrics = computeMetrics(
    oosResult.strategyEquity.filter((p) => p.date >= trainTo && (!testTo || p.date < testTo)),
  );
  const baseline = computeMetrics(runOn(ctx.timeline, ctx.volMult).strategyEquity.filter((p) => p.date >= trainTo && (!testTo || p.date < testTo)));
  folds.push({
    testYear: trainTo.slice(0, 4),
    chosen: { scoreHigh: best.combo.scoreHigh, scoreLow: best.combo.scoreLow, targetVol: best.combo.targetVol },
    isSharpe: best.sharpe,
    oosSharpe: oosMetrics.sharpe,
    oosCagr: oosMetrics.cagr,
    oosMaxDd: oosMetrics.maxDrawdown,
    baselineOosSharpe: baseline.sharpe,
  });
  console.log(
    `  ${trainTo.slice(0, 4)} 年：IS 选 ${JSON.stringify(best.combo.scoreHigh)}/${JSON.stringify(best.combo.scoreLow)}/vol${best.combo.targetVol}（IS 夏普 ${best.sharpe.toFixed(2)}）→ OOS 夏普 ${oosMetrics.sharpe.toFixed(2)}（现行参数 ${baseline.sharpe.toFixed(2)}）`,
  );
}

const runId = await latestRunId();
if (runId === null) {
  console.error("⚠ 无既有回测 run——先跑 npm run backtest，扫描结果无处挂载");
} else {
  await saveArtifacts(runId, [
    {
      kind: "sensitivity",
      data: {
        gridThreshold: gridA,
        gridVolDrift: gridB,
        note: "网格步长刻意取粗（阈值 ±0.05、波动目标 ±20%、漂移 ±2pp）：只在邻域内翻脸的结论不配上岗。",
      },
    },
    {
      kind: "walkforward",
      data: { folds, note: "每年只用截至上一年的数据从网格里选参，在当年验证（OOS）。OOS 长期显著差于 IS 就是过拟合成立的直接证据。" },
    },
  ]);
  console.log(`敏感性 + walk-forward 已落 run_artifacts（run #${runId}）`);
}
await getPool().end();
