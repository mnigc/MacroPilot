import { meanStd } from "./metrics.js";

/**
 * 重采样统计：自助法置信区间与蒙特卡洛前景。全部用固定种子的确定性随机数——
 * 同一份输入永远得到同一份输出，页面上"概率 X%"必须可复现，不能每次构建都抖动。
 *
 * 方法论立场：这里外推的是"**这套规则历史上的日收益分布**"，不是对未来的预测。
 * 块自助法保留短期相关与波动聚集（这是 i.i.d. 重采样做不到的），
 * 但它假设未来长得像过去——这个假设成立与否，页面文案必须说清楚。
 */

/** mulberry32：小而快的确定性 PRNG，种子相同 → 序列相同 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 平稳块自助法（stationary block bootstrap, Politis & Romano）：随机块长（几何分布，
 * 期望 blockLen）拼接出与原序列同长的重采样路径，保留波动聚集与短期自相关。
 */
export function bootstrapSample(returns: number[], blockLen: number, rand: () => number): number[] {
  const n = returns.length;
  if (n === 0) return [];
  const out: number[] = [];
  let i = Math.floor(rand() * n);
  while (out.length < n) {
    const block = 1 + Math.floor(-Math.log(1 - rand()) * blockLen); // 几何分布，期望 blockLen
    for (let k = 0; k < block && out.length < n; k++) {
      out.push(returns[i] ?? 0);
      i = (i + 1) % n;
    }
    i = Math.floor(rand() * n);
  }
  return out;
}

export function dailyReturns(equity: { date: string; value: number }[]): { dates: string[]; rets: number[] } {
  const dates: string[] = [];
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (prev && cur && prev.value > 0) {
      rets.push(cur.value / prev.value - 1);
      dates.push(cur.date);
    }
  }
  return { dates, rets };
}

export interface ConfidenceInterval {
  point: number;
  lo: number;
  hi: number;
}

/**
 * 夏普与最大回撤的 95% 自助法置信区间。回撤的置信区间偏乐观（重采样打散了
 * 回撤的时间聚集），所以页面文案必须注明"回撤 CI 仅供参考"。
 */
export function sharpeDrawdownCI(
  rets: number[],
  reps = 500,
  seed = 42,
): { sharpe: ConfidenceInterval; maxDrawdown: ConfidenceInterval } {
  const rand = rng(seed);
  const point = (xs: number[]): { sharpe: number; maxDrawdown: number } => {
    const { mean, std } = meanStd(xs);
    let peak = 1;
    let maxDd = 0;
    let v = 1;
    for (const r of xs) {
      v *= 1 + r;
      peak = Math.max(peak, v);
      maxDd = Math.min(maxDd, v / peak - 1);
    }
    return { sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0, maxDrawdown: maxDd };
  };
  const p = point(rets);
  const sharpes: number[] = [];
  const dds: number[] = [];
  for (let i = 0; i < reps; i++) {
    const s = point(bootstrapSample(rets, 20, rand));
    sharpes.push(s.sharpe);
    dds.push(s.maxDrawdown);
  }
  const quantile = (xs: number[], q: number) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] as number;
  };
  return {
    sharpe: { point: p.sharpe, lo: quantile(sharpes, 0.025), hi: quantile(sharpes, 0.975) },
    maxDrawdown: { point: p.maxDrawdown, lo: quantile(dds, 0.025), hi: quantile(dds, 0.975) },
  };
}

export interface FanChart {
  /** 前景月度刻度（相对起始日，交易日数：21/42/…/252） */
  horizons: number[];
  /** 各刻度的净值分位（起始净值 = 1） */
  p5: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
  /** 12 个月内任一时刻回撤超过阈值的概率（0~1） */
  drawdownProb: { threshold: number; probability: number }[];
}

/**
 * 蒙特卡洛前景：对历史日收益做块自助法，模拟 horizon 天路径 reps 条，
 * 输出净值分位带与回撤概率。语义是"历史上这套规则的分布长什么样"，
 * 不是"未来会涨多少"。
 */
export function monteCarloFan(rets: number[], horizon = 252, reps = 1000, seed = 42): FanChart {
  const rand = rng(seed);
  const horizons: number[] = [];
  for (let h = 21; h <= horizon; h += 21) horizons.push(h);

  const buckets = horizons.map(() => [] as number[]);
  const ddThresholds = [0.1, 0.2, 0.3];
  const ddHits = ddThresholds.map(() => 0);

  for (let i = 0; i < reps; i++) {
    const sample = bootstrapSample(rets, 20, rand);
    let v = 1;
    let peak = 1;
    let worstDd = 0;
    let hi = 0;
    for (let d = 0; d < horizon && d < sample.length; d++) {
      v *= 1 + (sample[d] as number);
      peak = Math.max(peak, v);
      worstDd = Math.min(worstDd, v / peak - 1);
      if (hi < buckets.length && d + 1 === horizons[hi]) {
        (buckets[hi] as number[]).push(v);
        hi++;
      }
    }
    ddThresholds.forEach((th, k) => {
      if (worstDd <= -th) ddHits[k] = (ddHits[k] as number) + 1;
    });
  }

  const quantileOf = (xs: number[], q: number) => {
    if (!xs.length) return NaN;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] as number;
  };

  return {
    horizons,
    p5: buckets.map((b) => quantileOf(b, 0.05)),
    p25: buckets.map((b) => quantileOf(b, 0.25)),
    p50: buckets.map((b) => quantileOf(b, 0.5)),
    p75: buckets.map((b) => quantileOf(b, 0.75)),
    p95: buckets.map((b) => quantileOf(b, 0.95)),
    drawdownProb: ddThresholds.map((th, k) => ({ threshold: th, probability: (ddHits[k] as number) / reps })),
  };
}

export interface AnalogWindow {
  start: string;
  end: string;
  distance: number;
  /** 窗口结束后 63/126/252 个交易日的基准腿远期收益（不足期为 null） */
  fwd63: number | null;
  fwd126: number | null;
  fwd252: number | null;
}

/**
 * 历史类比：在综合分序列里找与"最近 windowDays 天"最相似的 K 个历史窗口
 * （欧氏距离，剔除与当前窗口重叠的区间），报告窗口结束后的远期收益分布。
 * 回答的问题是"宏观状态像现在的时候，后来发生了什么"——条件化的历史统计，
 * 不是预测。
 */
export function analogWindows(
  scores: { date: string; score: number }[],
  equity: { date: string; value: number }[],
  windowDays = 60,
  topK = 10,
): AnalogWindow[] {
  const n = scores.length;
  if (n < windowDays * 3) return [];
  const priceAt = new Map(equity.map((p) => [p.date, p.value]));

  const fwdOf = (endIdx: number, horizon: number): number | null => {
    const startIdx = endIdx + 1;
    const end = startIdx + horizon - 1;
    const a = scores[startIdx];
    const b = scores[end];
    if (!a || !b) return null;
    const pa = priceAt.get(a.date);
    const pb = priceAt.get(b.date);
    if (pa === undefined || pb === undefined || pa <= 0) return null;
    return pb / pa - 1;
  };

  const tail = scores.slice(-windowDays).map((p) => p.score);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const norm = Math.sqrt(tail.reduce((a, b) => a + (b - mean) * (b - mean), 0)) || 1;

  const lastSafeIdx = n - 1 - 252; // 保证有 252 天远期窗口
  const candidates: AnalogWindow[] = [];
  for (let start = 0; start + windowDays <= Math.max(0, lastSafeIdx); start += 5) {
    const end = start + windowDays - 1;
    // 与当前窗口（最后 windowDays 天）重叠的候选无意义
    if (end >= n - windowDays) break;
    const win = scores.slice(start, start + windowDays).map((p) => p.score);
    const wm = win.reduce((a, b) => a + b, 0) / win.length;
    let dist = 0;
    for (let k = 0; k < windowDays; k++) {
      const a = ((win[k] as number) - wm) / norm;
      const b = ((tail[k] as number) - mean) / norm;
      dist += (a - b) * (a - b);
    }
    candidates.push({
      start: scores[start]?.date as string,
      end: scores[end]?.date as string,
      distance: Math.sqrt(dist / windowDays),
      fwd63: fwdOf(end, 63),
      fwd126: fwdOf(end, 126),
      fwd252: fwdOf(end, 252),
    });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, topK);
}
