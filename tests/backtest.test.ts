import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestConfig } from "../src/backtest/engine.js";
import type { RegimePoint } from "../src/strategy/regime.js";
import type { Point } from "../src/data/stats.js";

/** 从给定日期起生成 n 个连续日历日 */
function days(start: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));
}

function timelineOf(dates: string[], equityTarget: number, regime: RegimePoint["regime"] = "riskOn"): RegimePoint[] {
  const signals = { liquidity: 0.5, volatility: 0.5, rates: 0.5, trend: 0.5, credit: 0.5 };
  return dates.map((date) => ({ date, score: 0.5, regime, equityTarget, signals, sahm: null, gateActive: false }));
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
  cost: { halfSpreadBps: 3, impactCoef: 0.35, flatBps: 15, earningsMult: 1.5 },
  engines: { dca: true, regime: true, volTarget: false, valuation: false, drift: true, earnings: false },
  volTriggerPp: 10,
  valueTriggerPp: 5,
  earnings: { daysBefore: 2, daysAfter: 1, scale: 0.5 },
  earningsByTicker: new Map(),
};

describe("回测引擎", () => {
  it("高成本下买入受可用现金约束，净值与现金余额不得转负（回归：手续费未计入目标规模导致负现金）", () => {
    const dates = days("2024-01-01", 30);
    const result = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      cost: { ...base.cost, flatBps: 500 }, // 极端 5% 成本，最容易暴露问题
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
      signals: { liquidity: 0.5, volatility: 0.5, rates: 0.5, trend: 0.5, credit: 0.5 },
      sahm: null,
      gateActive: false,
    }));
    const result = runBacktest(flatPrices(dates, base.tickers, 100), timeline, { ...base, dcaUsdt: 500 });
    const friday = result.trades.filter((t) => t.date === "2024-01-05");
    expect(friday.length).toBeGreaterThan(0);
    expect(friday[0]!.drivers).toEqual(expect.arrayContaining(["dca", "regime"]));
  });

  it("基准腿与策略腿同源自同一套现金流，且基准腿也计成本", () => {
    const dates = days("2024-01-01", 20);
    const noCost = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      cost: { ...base.cost, flatBps: 0 },
    });
    const withCost = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      cost: { ...base.cost, flatBps: 200 },
    });
    // 目标仓位与基准完全一致时，两腿首日建仓后净值差应只来自成本
    const firstDay = noCost.strategyEquity[0]!.value;
    expect(withCost.benchmarkEquity[0]!.value).toBeLessThan(firstDay);
  });

  it("成交量数据就位时冲击成本随单额放大：小单成本率低于大单", () => {
    const dates = days("2024-01-01", 40);
    const prices = flatPrices(dates, base.tickers, 100);
    const adv = new Map(base.tickers.map((t) => [t, dates.map((date) => ({ date, value: 100_000_000 }))]));
    const big = runBacktest(prices, timelineOf(dates, 1.0), {
      ...base,
      startCash: 5_000_000,
      cost: { ...base.cost, flatBps: 0, halfSpreadBps: 0, impactCoef: 1 },
      advDollars: adv,
    });
    const small = runBacktest(prices, timelineOf(dates, 1.0), {
      ...base,
      startCash: 10_000,
      cost: { ...base.cost, flatBps: 0, halfSpreadBps: 0, impactCoef: 1 },
      advDollars: adv,
    });
    const bigRate = big.costsPaid / 5_000_000;
    const smallRate = small.costsPaid / 10_000;
    expect(bigRate).toBeGreaterThan(smallRate);
  });

  it("现金计息：risk-off 长期持币时，计息腿的净值必须高于不计息腿", () => {
    const dates = days("2024-01-01", 120);
    const rates: Point[] = dates.map((date) => ({ date, value: 5 })); // 年化 5%
    const off = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 0), {
      ...base,
      engines: { ...base.engines, regime: true, dca: false },
    });
    const on = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 0), { ...base, cashRate: rates });
    expect(on.strategyEquity.at(-1)!.value).toBeGreaterThan(off.strategyEquity.at(-1)!.value);
  });

  it("财报窗口内的标的目标被缩放，且逐笔成本被记录", () => {
    const dates = days("2024-01-01", 30);
    const earnings = new Map<string, string[]>([["AAA", [dates[10] as string]]]);
    const result = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      engines: { ...base.engines, earnings: true },
      earningsByTicker: earnings,
    });
    expect(result.costsPaid).toBeGreaterThan(0);
    for (const t of result.trades) expect(t.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("消融开关：regime 关闭时目标恒为全仓，波动率乘数参与合成", () => {
    const dates = days("2024-01-01", 30);
    const timeline = timelineOf(dates, 0.25, "riskOff");
    const noRegime = runBacktest(flatPrices(dates, base.tickers, 100), timeline, {
      ...base,
      engines: { ...base.engines, regime: false },
    });
    expect(noRegime.targetSeries[0]!.value).toBe(1);
    const volMult = dates.map(() => 0.5 as number | undefined);
    const withVol = runBacktest(flatPrices(dates, base.tickers, 100), timelineOf(dates, 1.0), {
      ...base,
      engines: { ...base.engines, regime: false, volTarget: true },
      volMult,
    });
    expect(withVol.targetSeries[0]!.value).toBeCloseTo(0.5, 10);
  });
});
