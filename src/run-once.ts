/**
 * 单次执行入口：npm run agent
 * 每次运行完成一轮完整决策：宏观信号 → 体制状态 → 目标权重（四引擎合成）→ paper 成交。
 * 可手动触发，也可由调度器定时运行；周五自动注入定投资金（当日幂等）。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { runOnce, type ExecutorConfig } from "./exec/executor.js";
import type { RegimeConfig } from "./strategy/regime.js";

const raw = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[] };
  engines: {
    dca: { amountUsdt: number };
    regime: { scoreHigh: number; scoreLow: number; allocation: Record<string, number>; signals: Record<string, { weight: number }> };
    drift: { thresholdPp: number };
    earnings: { enabled: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
  };
  execution: { minTradeUsdt: number; startCashUsdt?: number };
};

const s = raw.engines.regime.signals;
const cfg: ExecutorConfig = {
  tickers: raw.basket.tickers,
  mode: (process.env.EXECUTION_MODE as "paper" | "live") ?? "paper",
  startCash: raw.execution.startCashUsdt ?? 10_000,
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
  earnings: raw.engines.earnings,
};

if (cfg.mode === "live") {
  console.error("live 模式需要 RFQ 下单链路（待 API key 后启用），当前仅支持 paper。");
  process.exit(1);
}

const summary = await runOnce(cfg);

console.log(`=== MacroPilot 执行报告 ${summary.asOf}（${cfg.mode}）===`);
console.log(
  `体制: score=${summary.regime.score.toFixed(3)} regime=${summary.regime.regime} 目标股票仓位=${(summary.regime.equityTarget * 100).toFixed(0)}%`,
);
console.log(
  `信号分量: liquidity=${summary.regime.signals.liquidity.toFixed(2)} volatility=${summary.regime.signals.volatility.toFixed(2)} rates=${summary.regime.signals.rates.toFixed(2)} trend=${summary.regime.signals.trend.toFixed(2)}`,
);
if (summary.earningsAffected.length) {
  console.log(`⚠ 财报引擎生效: ${summary.earningsAffected.join(", ")} 临近财报，权重已缩放`);
}
console.log(`组合净值: $${summary.equityBefore.toFixed(2)} → $${summary.equityAfter.toFixed(2)}`);
console.log(`目标权重: ${Object.entries(summary.targetWeights).map(([t, w]) => `${t}=${(w * 100).toFixed(1)}%`).join(" ")}`);
if (summary.trades.length === 0) {
  console.log("本轮无需调仓（漂移在阈值内，且非定投日）");
} else {
  console.log(`成交 ${summary.trades.length} 笔:`);
  for (const t of summary.trades) {
    console.log(
      `  [${t.reason}] ${t.ticker} ${t.unitsDelta >= 0 ? "买入" : "卖出"} ${Math.abs(t.unitsDelta).toFixed(6)} 股，$${t.notionalUsdt.toFixed(2)}`,
    );
  }
}
