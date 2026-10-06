import { describe, expect, it } from "vitest";
import {
  volMultiplierSeries,
  valuationTiltSeries,
  sentimentTiltSeries,
  latestVolMultiplier,
  latestValuationTilt,
  latestSentimentTilt,
  composeEquityTarget,
  type VolTargetConfig,
  type ValuationConfig,
  type SentimentConfig,
} from "../src/strategy/overlays.js";
import type { Point } from "../src/data/stats.js";

const dates = (n: number, start = "2024-01-01"): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));

const vt: VolTargetConfig = { targetVol: 0.15, lookbackDays: 21, floor: 0.5, ceiling: 1.0 };
const val: ValuationConfig = { maxTilt: 0.15, lookbackYears: 20 };

/** 稳定小幅波动的价格序列：日收益 ±0.05% 交替 → 已实现波动 ≈ 0.05%×√252 ≈ 0.8% */
function calmPrices(n: number): Point[] {
  return dates(n).map((date, i) => ({ date, value: 100 * (1 + (i % 2 === 0 ? 0.0005 : -0.0005)) }));
}

/** 剧烈波动：日收益 ±3% 交替 → 年化 ≈ 3%×√252 ≈ 48% */
function wildPrices(n: number): Point[] {
  return dates(n).map((date, i) => ({ date, value: 100 * (1 + (i % 2 === 0 ? 0.03 : -0.03)) }));
}

describe("波动率目标叠加", () => {
  it("低波动 → 乘数顶到 ceiling（不加杠杆）", () => {
    const series = calmPrices(60);
    const byTicker = new Map([["AAA", series], ["BBB", series]]);
    const mults = volMultiplierSeries(byTicker, series.map((p) => p.date), vt);
    const tail = mults.slice(-10).filter((v): v is number => v !== undefined);
    expect(tail.length).toBeGreaterThan(0);
    for (const m of tail) expect(m).toBeCloseTo(1.0, 10);
  });

  it("高波动 → 乘数压向 floor，且不低于 floor", () => {
    const series = wildPrices(60);
    const byTicker = new Map([["AAA", series], ["BBB", series]]);
    const mults = volMultiplierSeries(byTicker, series.map((p) => p.date), vt);
    const tail = mults.slice(-10).filter((v): v is number => v !== undefined);
    expect(tail.length).toBeGreaterThan(0);
    for (const m of tail) {
      expect(m).toBeLessThan(0.6);
      expect(m).toBeGreaterThanOrEqual(vt.floor);
    }
  });

  it("最新值版本与序列版本口径一致（同一输入同一天）", () => {
    const series = wildPrices(60);
    const arrays = new Map([["AAA", series.map((p) => p.value)], ["BBB", series.map((p) => p.value)]]);
    const latest = latestVolMultiplier(arrays, vt);
    expect(latest).toBeDefined();
    expect(latest as number).toBeGreaterThanOrEqual(vt.floor);
    expect(latest as number).toBeLessThan(0.6);
  });
});

describe("估值锚叠加", () => {
  it("CAPE 处于滚动窗口高位 → 负偏移；低位 → 正偏移；幅度不超过 ±maxTilt", () => {
    // 震荡序列：每个点在自己的尾随窗口里有高有低，峰→负偏移、谷→正偏移
    const months = 240;
    const cape: Point[] = Array.from({ length: months }, (_, i) => ({
      date: `${String(2005 + Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}-01`,
      value: 22.5 + 12.5 * Math.sin((i / 18) * Math.PI),
    }));
    const calendar = cape.map((p) => p.date);
    const tilts = valuationTiltSeries(cape, calendar, val);
    const finite = tilts.filter((t): t is number => t !== undefined);
    expect(finite.length).toBeGreaterThan(100);
    expect(Math.max(...finite)).toBeGreaterThan(0.1); // 波谷：明显正偏移
    expect(Math.min(...finite)).toBeLessThan(-0.1); // 波峰：明显负偏移
    for (const t of finite) expect(Math.abs(t)).toBeLessThanOrEqual(val.maxTilt + 1e-12);
  });

  it("空 CAPE → 全 undefined（引擎按关闭处理）", () => {
    const tilts = valuationTiltSeries([], dates(10), val);
    expect(tilts.every((t) => t === undefined)).toBe(true);
    expect(latestValuationTilt([], val)).toBeUndefined();
  });

  it("合成：体制 × 波动率 × (1+估值)，并夹在 [0,1]", () => {
    expect(composeEquityTarget(1, 0.5, 0.1)).toBeCloseTo(0.55, 12);
    expect(composeEquityTarget(0.6, undefined, undefined)).toBeCloseTo(0.6, 12);
    expect(composeEquityTarget(1, 2, 0.5)).toBe(1); // 合成结果超 1 → 夹到 1
    expect(composeEquityTarget(0.25, 0.4, -1)).toBe(0); // 合成结果低于 0 → 夹到 0
  });
});

describe("情绪叠加", () => {
  const sent: SentimentConfig = { maxTilt: 0.1, lookbackDays: 120, minObs: 40 };

  it("读数不足 minObs → 全 undefined（历史无法回填，攒数据期引擎按关闭处理）", () => {
    const readings: Point[] = dates(30).map((date, i) => ({ date, value: 50 + (i % 5) }));
    const tilts = sentimentTiltSeries(readings, readings.map((p) => p.date), sent);
    expect(tilts.every((t) => t === undefined)).toBe(true);
    expect(latestSentimentTilt(readings, sent)).toBeUndefined();
  });

  it("空读数 → 全 undefined", () => {
    expect(sentimentTiltSeries([], dates(10), sent).every((t) => t === undefined)).toBe(true);
    expect(latestSentimentTilt([], sent)).toBeUndefined();
  });

  it("攒够 minObs 后出偏移：极端亢奋读数 → 满额负偏移；幅度不超过 ±maxTilt", () => {
    // 前 60 天 50（中性），随后一天 100（全体 long）→ 该日百分位 1 → 偏移 −maxTilt
    const readings: Point[] = dates(61).map((date, i) => ({ date, value: i < 60 ? 50 : 100 }));
    const tilts = sentimentTiltSeries(readings, readings.map((p) => p.date), sent);
    expect(tilts[38]).toBeUndefined(); // 第 39 天窗口内才有第 40 个读数（minObs）
    expect(tilts[39]).toBeDefined();
    expect(tilts[60]).toBeCloseTo(-sent.maxTilt, 12);
    for (const t of tilts.filter((v): v is number => v !== undefined)) {
      expect(Math.abs(t)).toBeLessThanOrEqual(sent.maxTilt + 1e-12);
    }
    expect(latestSentimentTilt(readings, sent)).toBeCloseTo(-sent.maxTilt, 12);
  });

  it("合成把情绪偏移乘在第四层：体制 × 波动率 × (1+估值) × (1+情绪)", () => {
    expect(composeEquityTarget(1, 0.5, 0.1, -0.2)).toBeCloseTo(0.44, 12);
    expect(composeEquityTarget(0.6, undefined, undefined, undefined)).toBeCloseTo(0.6, 12);
    expect(composeEquityTarget(1, 1, 0.2, 0.2)).toBe(1); // 超上限夹到 1
  });
});
