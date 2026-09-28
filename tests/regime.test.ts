import { describe, expect, it } from "vitest";
import { computeRegimeTimeline, nextRegime, type MacroBundle, type RegimeConfig } from "../src/strategy/regime.js";
import type { Point } from "../src/data/stats.js";

/**
 * 合成序列的形态必须符合信号的语义：百分位度量的是"当前相对自己过去 3 年的位置"，
 * 匀速线性漂移在百分位意义下≈没有信息（分量的百分位由浮点噪声决定）。
 * 真实体制切换是加速式的——先平静，再快速转变（QE 冲刺/暴跌崩盘），因此 fixture
 * 用 ease-in 二次曲线：转变越到后段越快，尾段恰好是百分位极值。
 */
function shaped(n: number, start: number, target: number, shiftStart: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    let value = start;
    if (i > shiftStart) {
      const t = (i - shiftStart) / (n - shiftStart);
      value = start + (target - start) * t * t; // ease-in：加速转变
    }
    out.push({ date: dateAt(i), value });
  }
  return out;
}

function dateAt(i: number): string {
  // 只需唯一且升序（序列按位置对齐，不区分周末）
  return new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

const cfg: RegimeConfig = {
  weights: { liquidity: 0.3, volatility: 0.3, rates: 0.2, trend: 0.2 },
  scoreHigh: 0.6,
  scoreLow: 0.3,
  scoreRelease: 0.45,
  allocation: { riskOn: 1.0, neutral: 0.6, riskOff: 0.25 },
};

describe("体制状态机（三态滞回）", () => {
  it("进入极态需越过外沿，回落/回升到中性需越过内沿", () => {
    expect(nextRegime(0.61, "neutral", cfg)).toBe("riskOn");
    expect(nextRegime(0.5, "riskOn", cfg)).toBe("riskOn"); // 间隙内保持，不抖
    expect(nextRegime(0.44, "riskOn", cfg)).toBe("neutral"); // 越过 release 才降档
    expect(nextRegime(0.29, "neutral", cfg)).toBe("riskOff");
    expect(nextRegime(0.35, "riskOff", cfg)).toBe("riskOff");
    expect(nextRegime(0.46, "riskOff", cfg)).toBe("neutral");
  });

  it("极态之后分数回到中间带必须能落回 neutral（回归：曾因缺少释放边沿而永久不可达）", () => {
    const seq = [0.7, 0.65, 0.5, 0.4, 0.2, 0.35, 0.5, 0.7];
    const seen: string[] = [];
    let state: "riskOn" | "neutral" | "riskOff" = "neutral";
    for (const s of seq) {
      state = nextRegime(s, state, cfg);
      seen.push(state);
    }
    expect(seen).toEqual(["riskOn", "riskOn", "riskOn", "neutral", "riskOff", "riskOff", "neutral", "riskOn"]);
    expect(seen).toContain("neutral");
  });

  it("未配置 scoreRelease 时取两阈值中点", () => {
    const noRelease = { scoreHigh: 0.6, scoreLow: 0.2 };
    expect(nextRegime(0.35, "riskOn", noRelease)).toBe("neutral"); // 中点 0.4
    expect(nextRegime(0.45, "riskOn", noRelease)).toBe("riskOn");
  });
});

const N = 1100;
const SHIFT = 650; // 前 650 天平静，后 450 天加速转变

function bundle(overrides: {
  liquidity?: [number, number];
  vix?: [number, number];
  rates?: [number, number];
  spx?: [number, number];
}): MacroBundle {
  return {
    // 模拟周频序列（每 5 天一个观测点），顺带覆盖对齐路径
    liquidity: shaped(N, ...(overrides.liquidity ?? [1_000_000, 1_000_000] as const), SHIFT).filter((_, i) => i % 5 === 0),
    volatility: shaped(N, ...(overrides.vix ?? [18, 18] as const), SHIFT),
    rates: shaped(N, ...(overrides.rates ?? [3, 3] as const), SHIFT),
    trend: shaped(N, ...(overrides.spx ?? [3000, 3000] as const), SHIFT),
  };
}

describe("体制引擎", () => {
  it("全面利好环境（放水+低波动+利率下行+趋势走强）应进入 riskOn", () => {
    const b = bundle({ liquidity: [900_000, 1_150_000], vix: [30, 12], rates: [4, 2.5], spx: [3000, 5000] });
    const timeline = computeRegimeTimeline(b, cfg);
    // 引擎预热（3 年百分位窗口）后应持续输出
    expect(timeline.length).toBeGreaterThan(100);
    const tail = timeline.slice(-60);
    const riskOnDays = tail.filter((p) => p.regime === "riskOn").length;
    expect(riskOnDays).toBeGreaterThan(40);
    for (const p of tail) {
      expect(p.equityTarget).toBe(cfg.allocation[p.regime]);
    }
  });

  it("全面恶化环境（缩表+恐慌+利率上行+趋势走弱）应进入 riskOff", () => {
    const b = bundle({ liquidity: [1_150_000, 900_000], vix: [12, 45], rates: [2.5, 4.5], spx: [5000, 3000] });
    const timeline = computeRegimeTimeline(b, cfg);
    const tail = timeline.slice(-60);
    const riskOffDays = tail.filter((p) => p.regime === "riskOff").length;
    expect(riskOffDays).toBeGreaterThan(40);
  });

  it("匀速漂移环境应停留在 neutral 附近，不产生频繁翻转", () => {
    // 全程恒定序列（无任何转变）→ 无信息 → 不应越过任何阈值
    const b = bundle({});
    const timeline = computeRegimeTimeline(b, cfg);
    expect(timeline.length).toBeGreaterThan(0);
    let switches = 0;
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const cur = timeline[i];
      if (prev && cur && cur.regime !== prev.regime) switches++;
    }
    expect(switches).toBeLessThanOrEqual(6);
  });

  it("温和单向转变不应触发频繁翻转（滞回生效）", () => {
    // 单一信号（VIX）大幅转变、其余不变：综合分被权重稀释到阈值区间内 → 状态保持
    const b = bundle({ vix: [30, 12] });
    const timeline = computeRegimeTimeline(b, cfg);
    let switches = 0;
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const cur = timeline[i];
      if (prev && cur && cur.regime !== prev.regime) switches++;
    }
    expect(switches).toBeLessThan(20);
  });
});

describe("Sahm 确认门", () => {
  it("3 个月均值较 12 个月低点抬升 ≥0.5pp 时，无论体制档位多高，目标仓位压回 risk-off 档", () => {
    // 失业率：前 9 个月 3.5，后 4 个月爬到 4.5 → sahm = mean(4.2,4.4,4.5) − 3.5 ≈ 0.87
    const labor: Point[] = [];
    for (let i = 0; i < 9; i++) labor.push({ date: `${2020 + Math.floor(i / 12)}-01-0${(i % 9) + 1}`, value: 3.5 });
    // 用月序号构造可读日期序列（date 仅要求升序唯一）
    labor.length = 0;
    const months = (n: number, v: number) => {
      for (let i = 0; i < n; i++) {
        const y = 2020 + Math.floor(i / 12);
        const m = String((i % 12) + 1).padStart(2, "0");
        labor.push({ date: `${y}-${m}-15`, value: v });
      }
    };
    months(12, 3.5);
    months(1, 4.2);
    months(1, 4.4);
    months(1, 4.5);
    const b = bundle({ vix: [12, 30] }); // 其余信号恒定
    b.labor = labor;
    const gateCfg: RegimeConfig = { ...cfg, gate: { sahmThreshold: 0.5 } };
    const timeline = computeRegimeTimeline(b, gateCfg);
    const tail = timeline.slice(-30);
    expect(tail.length).toBeGreaterThan(0);
    for (const p of tail) {
      expect(p.sahm).not.toBeNull();
      expect(p.sahm as number).toBeGreaterThanOrEqual(0.5);
      expect(p.gateActive).toBe(true);
      expect(p.equityTarget).toBeLessThanOrEqual(gateCfg.allocation.riskOff + 1e-12);
    }
  });

  it("无失业率序列时门不生效，equityTarget 与体制档位一致（回归：可选序列不得改变既有语义）", () => {
    const timeline = computeRegimeTimeline(bundle({}), cfg);
    for (const p of timeline) {
      expect(p.sahm).toBeNull();
      expect(p.gateActive).toBe(false);
      expect(p.equityTarget).toBe(cfg.allocation[p.regime]);
    }
  });
});

describe("信用信号", () => {
  it("缺失信用序列时信号记中性 0.5，综合分仍由其余信号重归一得出（不塌成 0）", () => {
    const timeline = computeRegimeTimeline(bundle({}), cfg);
    expect(timeline.length).toBeGreaterThan(0);
    for (const p of timeline) {
      expect(p.signals.credit).toBe(0.5);
      expect(p.score).toBeGreaterThan(0);
    }
  });

  it("信用利差飙升应把综合分往下拉", () => {
    // 其余信号不变，仅信用利差从 3.0 爬升到 6.0（末段 65 天加速，越过后段百分位极值）
    const creditCfg: RegimeConfig = { ...cfg, weights: { ...cfg.weights, credit: 0.2 } };
    const base = computeRegimeTimeline(bundle({}), creditCfg).at(-1)!.score;
    const n = 1100;
    const credit: Point[] = [];
    for (let i = 0; i < n; i++) {
      credit.push({ date: dateAt(i), value: i < n - 65 ? 3.0 : 3.0 + ((i - (n - 65)) / 65) * 3.0 });
    }
    const b = bundle({});
    b.credit = credit;
    const stressed = computeRegimeTimeline(b, creditCfg).at(-1)!.score;
    expect(stressed).toBeLessThan(base);
  });
});
