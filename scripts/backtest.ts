/**
 * 回测 CLI：npm run backtest
 *  - 宏观数据：FRED 直连（WALCL/VIXCLS/DGS10/SP500）
 *  - 股价：data/prices/{TICKER}.csv（date,close；由 GitHub Actions 同步或 python scripts/sync-prices.py 生成）
 *  - 无股价文件时用 SP500 指数做单资产代理，跑通全链路（引擎与篮子逻辑不变）
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fetchMacroBundle } from "../src/data/fred.js";
import { computeRegimeTimeline, type RegimeConfig } from "../src/strategy/regime.js";
import { runBacktest } from "../src/backtest/engine.js";
import { computeMetrics } from "../src/backtest/metrics.js";
import { parseFredCsv } from "../src/data/stats.js";

function loadStrategyConfig() {
  const raw = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
    basket: { tickers: string[] };
    engines: {
      dca: { amountUsdt: number };
      regime: { scoreHigh: number; scoreLow: number; allocation: Record<string, number>; signals: Record<string, { weight: number }> };
      drift: { thresholdPp: number };
    };
    execution: { minTradeUsdt: number; costBps?: number };
  };
  const s = raw.engines.regime.signals;
  return {
    tickers: raw.basket.tickers,
    dcaUsdt: raw.engines.dca.amountUsdt,
    driftThresholdPp: raw.engines.drift.thresholdPp,
    minTradeUsdt: raw.execution.minTradeUsdt,
    regime: {
      weights: {
        liquidity: s.liquidity?.weight ?? 0.3,
        volatility: s.volatility?.weight ?? 0.3,
        rates: s.rates?.weight ?? 0.2,
        trend: s.trend?.weight ?? 0.2,
      },
      scoreHigh: raw.engines.regime.scoreHigh,
      scoreLow: raw.engines.regime.scoreLow,
      allocation: {
        riskOn: raw.engines.regime.allocation.riskOn ?? 1.0,
        neutral: raw.engines.regime.allocation.neutral ?? 0.6,
        riskOff: raw.engines.regime.allocation.riskOff ?? 0.25,
      },
    } satisfies RegimeConfig,
  };
}

function loadPrices(tickers: string[]): { prices: Map<string, { date: string; value: number }[]>; usedTickers: string[] } {
  const prices = new Map<string, { date: string; value: number }[]>();
  const dir = "data/prices";
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".csv")) continue;
      const ticker = f.replace(".csv", "").toUpperCase();
      const points = parseFredCsv(readFileSync(`${dir}/${f}`, "utf8")); // 同为 date,value 格式
      if (points.length) prices.set(ticker, points);
    }
  }
  const available = tickers.filter((t) => prices.has(t));
  if (available.length === 0) {
    // 退化：SP500 指数当"篮子"用，验证引擎链路
    console.warn("⚠ data/prices/ 无可用股价，退化为 SP500 单资产代理（仅验证链路，不代表篮子表现）");
    return { prices: new Map(), usedTickers: [] };
  }
  return { prices: new Map(available.map((t) => [t, prices.get(t) as never])), usedTickers: available };
}

const cfg = loadStrategyConfig();

console.log("拉取 FRED 宏观数据…");
const bundle = await fetchMacroBundle();
for (const [k, v] of Object.entries(bundle)) {
  const last = v[v.length - 1];
  console.log(`  ${k}: ${v.length} 条，最新 ${last?.date} = ${last?.value}`);
}

const { prices, usedTickers } = loadPrices(cfg.tickers);
const tickers = usedTickers.length ? usedTickers : ["SP500_PROXY"];
if (!usedTickers.length) {
  prices.set("SP500_PROXY", bundle.trend); // 退化模式
}

mkdirSync("data/backtest", { recursive: true });
// 股价序列通常比 FRED SP500 短：以最长公共历史为准——直接用体制时间线，价格在缺失期 carry（首日无价则基准延后建仓）

const timeline = computeRegimeTimeline(bundle, cfg.regime);
console.log(`体制时间线：${timeline.length} 个交易日（${timeline[0]?.date} → ${timeline[timeline.length - 1]?.date}）`);
const regimeCount = timeline.reduce<Record<string, number>>((acc, p) => {
  acc[p.regime] = (acc[p.regime] ?? 0) + 1;
  return acc;
}, {});
console.log("  体制分布:", regimeCount);
const lastPoint = timeline[timeline.length - 1];
if (lastPoint) {
  console.log(`  当前: score=${lastPoint.score.toFixed(3)} regime=${lastPoint.regime} 目标仓位=${lastPoint.equityTarget * 100}%`);
}

console.log("\n运行回测…");
const result = runBacktest(prices, timeline, {
  tickers,
  startCash: 10_000,
  dcaUsdt: cfg.dcaUsdt,
  driftThresholdPp: cfg.driftThresholdPp,
  minTradeUsdt: cfg.minTradeUsdt,
  costBps: 15,
});

const strat = computeMetrics(result.strategyEquity);
const bench = computeMetrics(result.benchmarkEquity);
const fmt = (m: ReturnType<typeof computeMetrics>) =>
  `总收益 ${(m.totalReturn * 100).toFixed(1)}% | CAGR ${(m.cagr * 100).toFixed(1)}% | 最大回撤 ${(m.maxDrawdown * 100).toFixed(1)}% | 夏普 ${m.sharpe.toFixed(2)}`;
console.log(`\n策略  : ${fmt(strat)}`);
console.log(`基准  : ${fmt(bench)}`);
console.log(`交易  : ${result.trades.length} 笔，最终权重 ${JSON.stringify(Object.fromEntries(Object.entries(result.finalWeights).map(([k, v]) => [k, (v * 100).toFixed(1) + "%"])))}`);

writeFileSync(
  "data/backtest/result.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tickers,
      metrics: { strategy: strat, benchmark: bench },
      regimeDays: result.regimeDays,
      finalWeights: result.finalWeights,
      tradeCount: result.trades.length,
      equity: { strategy: result.strategyEquity, benchmark: result.benchmarkEquity },
      timeline: timeline.map((p) => ({ date: p.date, score: Number(p.score.toFixed(3)), regime: p.regime, equityTarget: p.equityTarget })),
    },
    null,
    2,
  ),
);
console.log("\n已写入 data/backtest/result.json");
