import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestConfig } from "../src/backtest/engine.js";
import type { RegimePoint } from "../src/strategy/regime.js";
import type { Point } from "../src/data/stats.js";

/** 从给定日期起生成 n 个连续日历日 */
function days(start: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));
}

function timelineOf(dates: string[], equityTarget: number, regime: RegimePoint["regime"] = "riskOn"): RegimePoint[] {
  const signals = { liquidity: 0.5, volatility: 0.5, rates: 0.5, trend: 0.5 };
  return dates.map((date) => ({ date, score: 0.5, regime, equityTarget, signals }));
}

function flatPrices(dates: string[], tickers: string[], value: number): Map<string, Point[]> {
  return new Map(tickers.map((t) => [t, dates.map((date) => ({ date, value }))]));
}

const base: BacktestConfig = {
  tickers: ["AAA", "BBB"],
  startCash: 10_000,
  dcaUsdt: 0,
  driftThresholdPp: 5,
  minTradeUsdt: 20,
  costBps: 15,
};

describe("回测引擎", () => {
  it("高成本下买入受可用现金约束，净值与现金余额不得转负（回归：手续费未计入目标规模导致负现金）", () => {
    const dates = days("2024-01-01", 30);
    const result = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      costBps: 500, // 极端 5% 成本，最容易暴露问题
      dcaUsdt: 500,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.finalWeights.cash).toBeGreaterThanOrEqual(0);
    for (const p of result.strategyEquity) expect(p.value).toBeGreaterThan(0);
  });

  it("定投日恰逢体制切换时，一笔交易同时记下两个触发引擎", () => {
    // 2024-01-05 是周五：前 4 天 neutral，从该日起切到 riskOn
    const dates = days("2024-01-01", 8);
    const timeline: RegimePoint[] = dates.map((date, i) => ({
      date,
      score: 0.5,
      regime: i >= 4 ? "riskOn" : "neutral",
      equityTarget: i >= 4 ? 1.0 : 0.6,
      signals: { liquidity: 0.5, volatility: 0.5, rates: 0.5, trend: 0.5 },
    }));
    const result = runBacktest(flatPrices(dates, base.tickers, 100), timeline, { ...base, dcaUsdt: 500 });
    const friday = result.trades.filter((t) => t.date === "2024-01-05");
    expect(friday.length).toBeGreaterThan(0);
    expect(friday[0]!.drivers).toEqual(expect.arrayContaining(["dca", "regime"]));
  });

  it("基准腿与策略腿同源自同一套现金流，且基准腿也计成本", () => {
    const dates = days("2024-01-01", 20);
    const noCost = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), { ...base, costBps: 0 });
    const withCost = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), { ...base, costBps: 200 });
    // 目标仓位与基准完全一致时，两腿首日建仓后净值差应只来自成本
    const firstDay = noCost.strategyEquity[0]!.value;
    expect(withCost.benchmarkEquity[0]!.value).toBeLessThan(firstDay);
  });
});
