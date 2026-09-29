/**
 * 回测 CLI：npm run backtest
 *
 * 一轮完整产出：
 *  1. 消融实验：同一数据、同一现金流，按引擎开关跑 5 个配置（dca → +regime → +vol → +value → full），
 *     每个配置一条 backtest_runs（variant 标签）——"每个引擎值不值得存在"由数据回答。
 *  2. full 配置附带全部统计产物落 run_artifacts：月度收益矩阵、滚动夏普、自助法置信区间、
 *     蒙特卡洛前景扇形、宏观类比窗口。
 *  3. full 配置的体制时间线与逐笔交易（含逐笔成本）照旧入库。
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadStrategyFile, loadBacktestContext, regimeConfigOf, volTargetConfigOf, valuationConfigOf } from "../src/backtest/context.js";
import { runBacktest, type BacktestConfig, type EngineToggles } from "../src/backtest/engine.js";
import { computeMetrics, monthlyReturns, rollingSharpe, type BacktestMetrics } from "../src/backtest/metrics.js";
import { sharpeDrawdownCI, monteCarloFan, analogWindows, dailyReturns } from "../src/backtest/resample.js";
import { getPool, saveBacktestRun, saveRegimePoints, saveTrades, saveArtifacts } from "../src/db/index.js";
import { MACRO_SERIES } from "../src/data/fred.js";
import type { Point } from "../src/data/stats.js";

const s = loadStrategyFile();
const ctx = await loadBacktestContext(s);

console.log(`宏观序列: ${Object.entries(MACRO_SERIES).map(([k, id]) => `${k}=${id}`).join(" ")}`);
for (const [k, v] of Object.entries(ctx.bundle)) {
  const last = (v as Point[]).at(-1);
  console.log(`  ${k}: ${(v as Point[]).length} 条，最新 ${last?.date} = ${last?.value}`);
}
for (const n of ctx.notes) console.log(`  ⚠ ${n}`);

const timeline = ctx.timeline;
const tickers = [...ctx.closes.keys()];
console.log(`\n体制时间线：${timeline.length} 个交易日（${timeline[0]?.date} → ${timeline.at(-1)?.date}）`);
const gateDays = timeline.filter((p) => p.gateActive).length;
if (gateDays) console.log(`  Sahm 确认门生效 ${gateDays} 天（最新读数 ${timeline.at(-1)?.sahm?.toFixed(2) ?? "—"}pp）`);
const regimeCount = timeline.reduce<Record<string, number>>((acc, p) => {
  acc[p.regime] = (acc[p.regime] ?? 0) + 1;
  return acc;
}, {});
console.log("  体制分布:", regimeCount);

const volCfg = volTargetConfigOf(s);
const valCfg = valuationConfigOf(s);
const volMultOn = volCfg.enabled && ctx.volMult.some((v) => v !== undefined);
const tiltOn = valCfg.enabled && ctx.tilt.some((v) => v !== undefined);
console.log(
  `  叠加层: 波动率目标 ${volMultOn ? `开（目标 ${(volCfg.targetVol * 100).toFixed(0)}%，最新乘数 ${(ctx.volMult.at(-1) ?? 1)?.toFixed(2)}）` : "关"} · 估值锚 ${tiltOn ? `开（CAPE ${ctx.cape.at(-1)?.value.toFixed(1)}，最新偏移 ${((ctx.tilt.at(-1) ?? 0) * 100).toFixed(1)}%）` : "关"}`,
);

const cost = s.execution.cost ?? { halfSpreadBps: 3, impactCoef: 0.35, earningsMult: 1.5 };
const cashRate = s.execution.cashInterest === false ? undefined : ctx.bundle.cash;

const engines = (over: Partial<EngineToggles>): EngineToggles => ({
  dca: true,
  regime: false,
  volTarget: false,
  valuation: false,
  drift: false,
  earnings: false,
  ...over,
});

/** 消融阶梯：逐层叠加，每一层的贡献 = 本行 − 上一行 */
const VARIANTS: { label: string; engines: EngineToggles }[] = [
  { label: "dca", engines: engines({}) },
  { label: "+regime", engines: engines({ regime: true }) },
  { label: "+vol", engines: engines({ regime: true, volTarget: true }) },
  { label: "+value", engines: engines({ regime: true, volTarget: true, valuation: true }) },
  { label: "full", engines: engines({ regime: true, volTarget: true, valuation: true, drift: true, earnings: true }) },
];

const batchId = new Date().toISOString().slice(0, 16);
const db = getPool();

interface VariantRow {
  label: string;
  metrics: BacktestMetrics;
  bench: BacktestMetrics;
  b40: BacktestMetrics;
  trades: number;
  costsPaid: number;
  turnover: number;
}

const rows: VariantRow[] = [];
let fullRunId: number | null = null;
const baseCfg: Omit<BacktestConfig, "engines"> = {
  tickers,
  startCash: s.execution.startCashUsdt ?? 10_000,
  dcaUsdt: s.engines.dca.amountUsdt,
  driftThresholdPp: s.engines.drift.thresholdPp,
  minTradeUsdt: s.execution.minTradeUsdt,
  cost: { ...cost, flatBps: s.execution.slippagePercent * 100 },
  volTriggerPp: volCfg.triggerPp,
  valueTriggerPp: valCfg.triggerPp,
  earnings: {
    daysBefore: s.engines.earnings.riskOffDaysBefore,
    daysAfter: s.engines.earnings.restoreDaysAfter,
    scale: s.engines.earnings.scaleFactor,
  },
  earningsByTicker: ctx.earningsByTicker,
  cashRate,
  advDollars: ctx.advDollars,
};

for (const variant of VARIANTS) {
  const result = runBacktest(ctx.closes, timeline, { ...baseCfg, engines: variant.engines, volMult: ctx.volMult, tilt: ctx.tilt });
  const metrics = computeMetrics(result.strategyEquity);
  const bench = computeMetrics(result.benchmarkEquity);
  const b40 = computeMetrics(result.benchmark6040Equity);
  const years = (Date.parse(timeline.at(-1)?.date ?? "") - Date.parse(timeline[0]?.date ?? "")) / 31_557_600_000;
  const gross = result.trades.reduce((a, t) => a + t.notionalUsdt, 0);
  const avgEquity = result.strategyEquity.reduce((a, p) => a + p.value, 0) / Math.max(1, result.strategyEquity.length);
  metrics.turnoverPct = years > 0 && avgEquity > 0 ? gross / 2 / avgEquity / years : 0;
  rows.push({ label: variant.label, metrics, bench, b40, trades: result.trades.length, costsPaid: result.costsPaid, turnover: metrics.turnoverPct });
  console.log(
    `  [${variant.label.padEnd(7)}] CAGR ${(metrics.cagr * 100).toFixed(1)}% · 回撤 ${(metrics.maxDrawdown * 100).toFixed(1)}% · 夏普 ${metrics.sharpe.toFixed(2)} · 换手 ${metrics.turnoverPct.toFixed(2)}× · 成本 $${result.costsPaid.toFixed(0)} · ${result.trades.length} 笔`,
  );

  const runId = await saveBacktestRun({
    tickers,
    variant: variant.label,
    params: {
      batchId,
      engines: variant.engines,
      weights: regimeConfigOf(s).weights,
      scoreHigh: s.engines.regime.scoreHigh,
      scoreLow: s.engines.regime.scoreLow,
      scoreRelease: regimeConfigOf(s).scoreRelease,
      allocation: s.engines.regime.allocation,
      gate: s.engines.regime.gate ?? null,
      dcaUsdt: baseCfg.dcaUsdt,
      driftThresholdPp: baseCfg.driftThresholdPp,
      minTradeUsdt: baseCfg.minTradeUsdt,
      cost: baseCfg.cost,
      volTarget: volMultOn ? volCfg : null,
      valuation: tiltOn ? valCfg : null,
      cashInterest: !!cashRate,
      earningsWindow: baseCfg.earnings,
    },
    metrics: { strategy: metrics, benchmark: bench, benchmark6040: b40 },
    regimeDays: result.regimeDays,
    finalWeights: result.finalWeights,
    equity: {
      strategy: variant.label === "full" ? result.strategyEquity : result.strategyEquity.filter((_, i) => i % 5 === 0),
      benchmark: variant.label === "full" ? result.benchmarkEquity : result.benchmarkEquity.filter((_, i) => i % 5 === 0),
      benchmark6040: variant.label === "full" ? result.benchmark6040Equity : result.benchmark6040Equity.filter((_, i) => i % 5 === 0),
    },
  });
  if (variant.label === "full") {
    fullRunId = runId;
    await saveRegimePoints(
      runId,
      timeline.map((p) => ({ date: p.date, score: p.score, regime: p.regime, equityTarget: p.equityTarget, signals: p.signals })),
    );
    await saveTrades(runId, result.trades);
  }
}

console.log(`\n消融批 ${batchId} 已入库（${rows.length} 条 run）`);

// ---- full 配置的统计产物 ----
if (fullRunId !== null) {
  const fullResult = runBacktest(ctx.closes, timeline, { ...baseCfg, engines: VARIANTS.at(-1)!.engines, volMult: ctx.volMult, tilt: ctx.tilt });
  const stratRets = dailyReturns(fullResult.strategyEquity).rets;
  const benchRets = dailyReturns(fullResult.benchmarkEquity).rets;
  const ciStrat = sharpeDrawdownCI(stratRets);
  const ciBench = sharpeDrawdownCI(benchRets);
  const fan = monteCarloFan(stratRets);
  const analog = analogWindows(
    timeline.map((p) => ({ date: p.date, score: p.score })),
    fullResult.benchmarkEquity,
  );

  await saveArtifacts(fullRunId, [
    { kind: "monthly", data: { strategy: monthlyReturns(fullResult.strategyEquity), benchmark: monthlyReturns(fullResult.benchmarkEquity) } },
    { kind: "rolling", data: { strategy: rollingSharpe(fullResult.strategyEquity), benchmark: rollingSharpe(fullResult.benchmarkEquity) } },
    {
      kind: "bootstrap",
      data: {
        strategy: ciStrat,
        benchmark: ciBench,
        note: "块自助法（期望块长 20 交易日，500 次重采样，固定种子）·回撤 CI 因重采样打散时间聚集而偏乐观，仅供参考",
      },
    },
    {
      kind: "fan",
      data: {
        ...fan,
        note: "蒙特卡洛前景：对策略历史日收益做块自助法外推 12 个月（1000 条路径，固定种子）。语义是'这套规则历史上的收益分布'，不是对未来收益的预测。",
      },
    },
    {
      kind: "analog",
      data: {
        windows: analog,
        asOf: timeline.at(-1)?.date ?? null,
        note: "在综合分历史里找与最近 60 个交易日形态最像的窗口（归一化欧氏距离，步长 5 天采样，距离越小越像），远期收益为窗口结束后 63/126/252 个交易日的基准腿（等权买入持有）收益。",
      },
    },
  ]);
  console.log(`统计产物已落 run_artifacts（run #${fullRunId}）：monthly / rolling / bootstrap / fan / analog`);
}

mkdirSync("data/backtest", { recursive: true });
writeFileSync(
  "data/backtest/result.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), batchId, tickers, ablation: rows, notes: ctx.notes }, null, 2),
);
console.log("摘要已写入 data/backtest/result.json");
await db.end();
