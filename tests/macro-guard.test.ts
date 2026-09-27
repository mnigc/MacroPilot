import { describe, expect, it } from "vitest";
import { MacroDataError, validateMacroBundle } from "../src/data/fred.js";
import type { MacroBundle } from "../src/strategy/regime.js";
import type { Point } from "../src/data/stats.js";

/** 2026-09-25 = 本轮实测的 SP500 最新日；其余序列按真实尾部滞后错开 */
function series(n: number, endDate: string, stepDays = 1): Point[] {
  const out: Point[] = [];
  const end = Date.parse(endDate);
  for (let i = n - 1; i >= 0; i--) {
    out.push({ date: new Date(end - i * stepDays * 86_400_000).toISOString().slice(0, 10), value: i });
  }
  return out;
}

function bundleWith(overrides: Partial<MacroBundle> = {}): MacroBundle {
  return {
    liquidity: series(300, "2026-09-23", 7), // WALCL 周频，落后 2 天
    volatility: series(900, "2026-09-22"), // VIX 落后 3 天
    rates: series(900, "2026-09-24"), // DGS10 落后 1 天
    trend: series(900, "2026-09-25"), // SP500 主日历
    ...overrides,
  };
}

describe("宏观数据完整性守卫", () => {
  it("真实尾部滞后（WALCL 2d / VIX 3d / DGS10 1d）应当放行", () => {
    expect(() => validateMacroBundle(bundleWith())).not.toThrow();
  });

  it("某序列停更多于阈值时必须硬失败，而不是让过期百分位进决策", () => {
    const stale = bundleWith({ volatility: series(900, "2026-08-01") }); // 落后 55 天
    expect(() => validateMacroBundle(stale)).toThrow(MacroDataError);
    expect(() => validateMacroBundle(stale)).toThrow(/VIXCLS.*断供/);
  });

  it("空序列是错误，不能静默当 0 或跳过", () => {
    expect(() => validateMacroBundle(bundleWith({ rates: [] }))).toThrow(/DGS10.*为空/);
    expect(() => validateMacroBundle(bundleWith({ trend: [] }))).toThrow(/主日历 SP500 为空/);
  });

  it("新鲜度正常但共同交易日不足阈值时硬失败", () => {
    // 只有 50 个观测：尾部滞后为 0（过得了新鲜度检查），但共同交易日低于 60 的地板
    const rates = series(50, "2026-09-25", 8);
    expect(() => validateMacroBundle(bundleWith({ rates }))).toThrow(/共同交易日/);
  });

  it("阈值边界：恰好 14 天放行，15 天拒绝", () => {
    expect(() => validateMacroBundle(bundleWith({ rates: series(900, "2026-09-11") }))).not.toThrow();
    expect(() => validateMacroBundle(bundleWith({ rates: series(900, "2026-09-10") }))).toThrow(MacroDataError);
  });
});
