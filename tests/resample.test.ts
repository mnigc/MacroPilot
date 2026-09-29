import { describe, expect, it } from "vitest";
import { rng, bootstrapSample, sharpeDrawdownCI, monteCarloFan, analogWindows, dailyReturns } from "../src/backtest/resample.js";
import { monthlyReturns, rollingSharpe } from "../src/backtest/metrics.js";

/** 确定性伪随机数：同种子同序列——页面上每一个"概率"都必须可复现 */
describe("确定性随机与块自助法", () => {
  it("同种子序列一致，不同种子不同", () => {
    const a = Array.from({ length: 8 }, () => rng(42)());
    const b = Array.from({ length: 8 }, () => rng(42)());
    const c = Array.from({ length: 8 }, () => rng(7)());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("重采样与原序列等长，且全部元素来自原序列", () => {
    const rets = [0.01, -0.02, 0.005, 0.03, -0.01, 0.002, -0.005, 0.01, 0.02, -0.03];
    const sample = bootstrapSample(rets, 20, rng(1));
    expect(sample.length).toBe(rets.length);
    const pool = new Set(rets);
    for (const r of sample) expect(pool.has(r)).toBe(true);
  });
});

describe("自助法置信区间与蒙特卡洛", () => {
  // 有明确正漂移的序列
  const rets = Array.from({ length: 600 }, (_, i) => 0.0004 + ((i % 7) - 3) * 0.0008);

  it("夏普 CI：点估计落在区间内，区间有序", () => {
    const ci = sharpeDrawdownCI(rets, 300, 42);
    expect(ci.sharpe.point).toBeGreaterThan(0);
    expect(ci.sharpe.lo).toBeLessThanOrEqual(ci.sharpe.point);
    expect(ci.sharpe.point).toBeLessThanOrEqual(ci.sharpe.hi);
    expect(ci.maxDrawdown.lo).toBeLessThanOrEqual(ci.maxDrawdown.point);
  });

  it("固定种子 → 结果完全可复现", () => {
    expect(sharpeDrawdownCI(rets, 200, 42)).toEqual(sharpeDrawdownCI(rets, 200, 42));
  });

  it("扇形图：分位数单调（p5 ≤ p25 ≤ p50 ≤ p75 ≤ p95），回撤概率随阈值收紧而下降", () => {
    const fan = monteCarloFan(rets, 252, 500, 42);
    expect(fan.horizons.length).toBe(12);
    for (let i = 0; i < fan.horizons.length; i++) {
      expect(fan.p5[i]!).toBeLessThanOrEqual(fan.p25[i]! + 1e-9);
      expect(fan.p25[i]!).toBeLessThanOrEqual(fan.p50[i]! + 1e-9);
      expect(fan.p50[i]!).toBeLessThanOrEqual(fan.p75[i]! + 1e-9);
      expect(fan.p75[i]!).toBeLessThanOrEqual(fan.p95[i]! + 1e-9);
    }
    const probs = fan.drawdownProb.map((d) => d.probability);
    expect(probs[0]).toBeGreaterThanOrEqual(probs[1]!);
    expect(probs[1]).toBeGreaterThanOrEqual(probs[2]!);
  });
});

describe("历史类比窗口", () => {
  it("在可分辨的形态里找回相似的窗口，远期收益字段齐全", () => {
    // 综合分序列：0.2 与 0.8 交替的"方块"，最近 60 天是高位方块
    const n = 800;
    const scores = Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      score: i >= n - 60 ? 0.8 : Math.floor(i / 100) % 2 === 0 ? 0.2 : 0.8,
    }));
    // 净值跟着分数走：高分段涨、低分段跌 → 相似窗口的远期收益可计算
    const equity: { date: string; value: number }[] = [];
    let v = 100;
    for (let i = 0; i < n; i++) {
      v *= 1 + (scores[i]!.score === 0.8 ? 0.001 : -0.001);
      equity.push({ date: scores[i]!.date, value: v });
    }
    const windows = analogWindows(scores, equity, 60, 5);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThanOrEqual(5);
    for (const w of windows) {
      expect(w.end < scores.at(-1)!.date).toBe(true);
      expect(w.distance).toBeGreaterThanOrEqual(0);
      // 末尾 252 天不作为候选（远期窗口不完整），但候选自身 252 天远期必须可算
      expect(w.fwd252).not.toBeNull();
    }
    // 与当前窗口（高位方块）相似的候选应偏向高分段
    const startScores = windows.map((w) => scores.findIndex((s) => s.date === w.start));
    const highFreq = startScores.filter((i) => scores[i!]!.score === 0.8).length / windows.length;
    expect(highFreq).toBeGreaterThan(0.5);
  });

  it("历史不足时返回空数组而不抛错", () => {
    const few = Array.from({ length: 100 }, (_, i) => ({ date: `2020-01-${String(i + 1).padStart(2, "0")}`, score: 0.5 }));
    expect(analogWindows(few, few.map((p) => ({ date: p.date, value: 100 })), 60, 5)).toEqual([]);
  });
});

describe("月度矩阵与滚动夏普", () => {
  it("月度收益：相邻月末日相除，缺月为 null", () => {
    const equity = [
      { date: "2024-01-31", value: 100 },
      { date: "2024-02-29", value: 110 },
      { date: "2024-04-30", value: 121 }, // 3 月缺
    ];
    const m = monthlyReturns(equity);
    expect(m.length).toBe(1);
    const row = m[0]!;
    expect(row.year).toBe("2024");
    expect(row.months[0]).toBeNull(); // 1 月无前月
    expect(row.months[1]).toBeCloseTo(0.1, 10);
    expect(row.months[2]).toBeNull(); // 3 月缺失
    expect(row.months[3]).toBeCloseTo(0.1, 10);
  });

  it("滚动夏普长度 = 收益样本数 − 窗口 + 1（每个窗口恰为 252 个收益）", () => {
    const equity = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, value: 100 + i }));
    const rs = rollingSharpe(equity, 252);
    expect(rs.length).toBe(399 - 252 + 1);
  });

  it("dailyReturns 与净值曲线逐日对应", () => {
    const dr = dailyReturns([
      { date: "a", value: 100 },
      { date: "b", value: 101 },
    ]);
    expect(dr.rets.length).toBe(1);
    expect(dr.rets[0]).toBeCloseTo(0.01, 12);
  });
});
