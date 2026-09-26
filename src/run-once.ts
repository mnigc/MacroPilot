/**
 * 单次执行入口：npm run agent
 * 每次运行完成一轮完整决策：宏观信号 → 体制状态 → 目标权重（四引擎合成）→ 成交。
 *
 * EXECUTION_MODE=paper 以最近收盘价纸面成交；=live 走聚合器询价真实下单（RFQ 视路由而定），
 * 需要 BINANCE_API_KEY/SECRET_KEY + WALLET_PRIVATE_KEY（专用小额钱包）。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runOnce, type ExecutorConfig } from "./exec/executor.js";
import type { RegimeConfig } from "./strategy/regime.js";
import { splitDrivers } from "./strategy/drivers.js";

interface StrategyFile {
  basket: { tickers: string[]; quoteAsset: { chainId: number; symbol: string; address: string } };
  engines: {
    dca: { amountUsdt: number };
    regime: {
      scoreHigh: number;
      scoreLow: number;
      scoreRelease?: number;
      allocation: Record<string, number>;
      signals: Record<string, { weight: number }>;
    };
    drift: { thresholdPp: number };
    earnings: { enabled: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
  };
  execution: { minTradeUsdt: number; slippagePercent: number; maxPriceImpactPercent: number; mode: string; startCashUsdt?: number };
}

const raw = JSON.parse(readFileSync("config/strategy.json", "utf8")) as StrategyFile;
const s = raw.engines.regime.signals;
const mode = (process.env.EXECUTION_MODE as "paper" | "live") ?? "paper";

const cfg: ExecutorConfig = {
  tickers: raw.basket.tickers,
  mode,
  startCash: raw.execution.startCashUsdt ?? 10_000,
  dcaUsdt: raw.engines.dca.amountUsdt,
  driftThresholdPp: raw.engines.drift.thresholdPp,
  minTradeUsdt: raw.execution.minTradeUsdt,
  slippagePercent: raw.execution.slippagePercent,
  regime: {
    weights: {
      liquidity: s.liquidity?.weight ?? 0.3,
      volatility: s.volatility?.weight ?? 0.3,
      rates: s.rates?.weight ?? 0.2,
      trend: s.trend?.weight ?? 0.2,
    },
    scoreHigh: raw.engines.regime.scoreHigh,
    scoreLow: raw.engines.regime.scoreLow,
    scoreRelease: raw.engines.regime.scoreRelease ?? 0.45,
    allocation: {
      riskOn: raw.engines.regime.allocation.riskOn ?? 1.0,
      neutral: raw.engines.regime.allocation.neutral ?? 0.6,
      riskOff: raw.engines.regime.allocation.riskOff ?? 0.25,
    },
  } satisfies RegimeConfig,
  earnings: raw.engines.earnings,
};

if (mode === "live") {
  const { BinanceWeb3Client } = await import("./binance/client.js");
  const { AggregatorApi } = await import("./binance/aggregator.js");
  const { RwaApi } = await import("./binance/rwa.js");
  const { resolveTokens } = await import("./binance/tokens.js");
  const { createLiveTrader } = await import("./exec/live.js");

  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_SECRET_KEY;
  const privateKey = process.env.WALLET_PRIVATE_KEY as Hex | undefined;
  if (!apiKey || !secretKey) throw new Error("live 模式需要 BINANCE_API_KEY / BINANCE_SECRET_KEY");
  if (!privateKey) throw new Error("live 模式需要 WALLET_PRIVATE_KEY（专用小额钱包，勿用主钱包）");

  const client = new BinanceWeb3Client(apiKey, secretKey);
  const aggregator = new AggregatorApi(client);
  const chainId = String(raw.basket.quoteAsset.chainId);
  const walletAddress = privateKeyToAccount(privateKey).address;
  const { tokens, missing, illiquid, liquidity } = await resolveTokens(new RwaApi(client), cfg.tickers, {
    chainId,
    probe: {
      aggregator,
      userWalletAddress: walletAddress,
      quoteAsset: { address: raw.basket.quoteAsset.address },
    },
  });
  if (missing.length) throw new Error(`以下 ticker 未能解析为链上合约地址：${missing.join(", ")}（真实成交已中止）`);
  if (illiquid.length) throw new Error(`以下 ticker 链上无盘口（询价冲击 >25%）：${illiquid.join(", ")}（真实成交已中止）`);
  for (const [t, rep] of Object.entries(liquidity)) {
    if (rep.candidates.length < 2) continue;
    console.warn(
      `  选币 ${t} → ${rep.chosen}（候选：${rep.candidates.map((c) => `${c.symbol} ${c.impactPercent === null ? "询价失败" : `冲击 ${c.impactPercent.toFixed(2)}%`}`).join(" / ")}）`,
    );
  }

  cfg.trader = createLiveTrader({
    aggregator,
    privateKey,
    quoteToken: raw.basket.quoteAsset.address as Address,
    addresses: Object.fromEntries(Object.entries(tokens).map(([t, ref]) => [t, ref.address as Address])),
    binanceChainId: chainId,
    rpcUrl: process.env.BSC_RPC_URL,
    slippagePercent: raw.execution.slippagePercent,
    maxPriceImpactPercent: raw.execution.maxPriceImpactPercent,
    minNotionalUsdt: raw.execution.minTradeUsdt,
  });
  console.warn(`⚠ live 模式：即将以真实资金下单，篮子已解析 → ${Object.entries(tokens).map(([t, r]) => `${t}:${r.address.slice(0, 10)}…`).join(" ")}`);
}

const summary = await runOnce(cfg);

console.log(`=== MacroPilot 执行报告 ${summary.asOf}（${cfg.mode}）===`);
console.log(
  `体制: score=${summary.regime.score.toFixed(3)} regime=${summary.regime.regime} 目标股票仓位=${(summary.regime.equityTarget * 100).toFixed(0)}%`,
);
console.log(
  `信号分量: liquidity=${summary.regime.signals.liquidity.toFixed(2)} volatility=${summary.regime.signals.volatility.toFixed(2)} rates=${summary.regime.signals.rates.toFixed(2)} trend=${summary.regime.signals.trend.toFixed(2)}`,
);
if (summary.earningsAffected.length) console.log(`⚠ 财报引擎生效: ${summary.earningsAffected.join(", ")} 临近财报，权重已缩放`);
console.log(`组合净值: $${summary.equityBefore.toFixed(2)} → $${summary.equityAfter.toFixed(2)}`);
console.log(`目标权重: ${Object.entries(summary.targetWeights).map(([t, w]) => `${t}=${(w * 100).toFixed(1)}%`).join(" ")}`);
if (summary.trades.length === 0) {
  console.log("本轮无需调仓（漂移在阈值内，且非定投日）");
} else {
  console.log(`成交 ${summary.trades.length} 笔（逐笔标注全部触发引擎）:`);
  for (const t of summary.trades) {
    const drivers = splitDrivers(t.drivers.join(","))
      .map((d) => ({ seed: "初始建仓", dca: "定投", regime: "体制", drift: "漂移", earnings: "财报" })[d])
      .join("+");
    console.log(
      `  [${drivers}] ${t.ticker} ${t.unitsDelta >= 0 ? "买入" : "卖出"} ${Math.abs(t.unitsDelta).toFixed(6)} 股，$${t.notionalUsdt.toFixed(2)}${t.txHash ? ` tx=${t.txHash.slice(0, 14)}…` : ""}`,
    );
  }
}
