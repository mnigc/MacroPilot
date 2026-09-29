import type { Point } from "../data/stats.js";
import { alignToCalendar, percentileRank } from "../data/stats.js";

/**
 * 叠加层：体制档位之外的连续仓位修正。它们不投票、不改体制状态机，
 * 只在体制给出的目标仓位上做乘法——所以消融实验能干净地测出每一层各自的贡献。
 *
 *   波动率目标  realizedVol → multiplier：波动升高自动减仓，回落自动恢复（不杠杆，ceiling ≤ 1）
 *   估值锚      CAPE 滚动百分位 → ±maxTilt 的线性偏移：贵时少买，便宜时多买
 */

export interface VolTargetConfig {
  /** 目标年化波动（如 0.15） */
  targetVol: number;
  /** 已实现波动的回看交易日数（21 ≈ 一个月） */
  lookbackDays: number;
  /** multiplier 上下限：不杠杆（ceiling ≤ 1），危机中也保留底仓 */
  floor: number;
  ceiling: number;
}

export interface ValuationConfig {
  /** 最大偏移幅度（0.15 = ±15% 权益仓位） */
  maxTilt: number;
  /** CAPE 百分位的滚动回看年数 */
  lookbackYears: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 股价序列按日期 step-carry 取值（缺失日沿用最近收盘） */
function carryLookup(points: Point[]): (date: string) => number | undefined {
  const map = new Map(points.map((p) => [p.date, p.value]));
  let last: number | undefined;
  const cache = new Map<string, number | undefined>();
  return (date: string) => {
    if (cache.has(date)) return cache.get(date);
    const v = map.get(date);
    if (v !== undefined) last = v;
    cache.set(date, last);
    return last;
  };
}

/**
 * 波动率目标乘数序列：对每个交易日，用截至当日的等权篮子日收益算 lookback 天已实现波动
 * （年化），乘数 = targetVol / realizedVol，夹在 [floor, ceiling]。
 * 用 step-carry 取价，缺失日不产生伪收益；回看不足时返回 undefined（调用方按 1 处理）。
 */
export function volMultiplierSeries(
  closesByTicker: Map<string, Point[]>,
  calendar: string[],
  cfg: VolTargetConfig,
): (number | undefined)[] {
  const lookups = [...closesByTicker.values()].map(carryLookup);
  const n = lookups.length;
  /** 各标的截至前一交易日的 carried 收盘：等权收益要逐标的的前收，不能直接对价格求和 */
  const prevPrices: (number | undefined)[] = new Array(n).fill(undefined);

  const rets: number[] = []; // 与 calendar 对齐的篮子日收益（前 lookback+1 日为 NaN）
  const out: (number | undefined)[] = [];

  for (let i = 0; i < calendar.length; i++) {
    const curs = lookups.map((l) => l(calendar[i] as string));
    let basketRet: number | undefined;
    // 等权篮子：先逐标的算收益再平均。直接对价格求和取比值是价格加权（道指式），
    // 权重会偏向股价最高的标的，与"等权篮子"的口径和实际持仓方式都不符
    if (n > 0 && curs.every((v) => v !== undefined) && prevPrices.every((v) => v !== undefined && v > 0)) {
      basketRet = lookups.reduce((a, _l, k) => a + (curs[k] as number) / (prevPrices[k] as number) - 1, 0) / n;
    }
    rets.push(basketRet !== undefined ? basketRet : NaN);
    for (let k = 0; k < n; k++) prevPrices[k] = curs[k] ?? prevPrices[k];

    // 滚动窗口：最近 lookbackDays 个有效收益
    if (i < cfg.lookbackDays) {
      out.push(undefined);
      continue;
    }
    const win: number[] = [];
    for (let j = i; j > i - cfg.lookbackDays && j >= 0; j--) {
      const r = rets[j];
      if (r !== undefined && Number.isFinite(r)) win.push(r);
    }
    if (win.length < Math.max(10, cfg.lookbackDays * 0.6)) {
      out.push(undefined);
      continue;
    }
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const variance = win.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, win.length - 1);
    const realized = Math.sqrt(variance * 252);
    out.push(realized > 0 ? clamp(cfg.targetVol / realized, cfg.floor, cfg.ceiling) : undefined);
  }
  return out;
}

/**
 * 估值锚偏移序列：CAPE 对每个交易日取"截至当日的最新月度观测"，在滚动 lookbackYears
 * 窗口（不足则用全部可得历史）里算百分位；偏移 = (0.5 − 百分位) × 2 × maxTilt，
 * 连续线性、天然对称——p80 时 ≈ −0.6×maxTilt，p100 才吃满 −maxTilt。
 * 无 CAPE 数据时整个序列为 undefined（估值引擎按关闭处理）。
 */
export function valuationTiltSeries(
  cape: Point[],
  calendar: string[],
  cfg: ValuationConfig,
): (number | undefined)[] {
  if (!cape.length) return calendar.map(() => undefined);
  const aligned = alignToCalendar(cape, calendar);
  const maxObs = cfg.lookbackYears * 12;
  const out: (number | undefined)[] = [];
  for (let i = 0; i < calendar.length; i++) {
    const v = aligned[i];
    if (v === undefined) {
      out.push(undefined);
      continue;
    }
    const hist: number[] = [];
    for (let j = i; j >= 0 && hist.length < maxObs; j--) {
      const h = aligned[j];
      if (h !== undefined) hist.push(h);
    }
    const pctile = percentileRank(hist, v);
    out.push(clamp((0.5 - pctile) * 2, -1, 1) * cfg.maxTilt);
  }
  return out;
}

/** 组合后的目标权益仓位：体制档位 × 波动率乘数 × (1 + 估值偏移)，夹在 [0,1] */
export function composeEquityTarget(regimeTarget: number, volMult: number | undefined, tilt: number | undefined): number {
  return clamp(regimeTarget * (volMult ?? 1) * (1 + (tilt ?? 0)), 0, 1);
}

/* ---------- 执行器用的"只算最新一天"版本 ---------- */

/**
 * 最新波动率乘数。输入为每只标的最近 lookbackDays+5 个收盘（升序），日期对齐由调用方保证
 * （取各标的共同交易日）；执行器只关心最新读数，不需要整条序列。
 */
export function latestVolMultiplier(
  closesByTicker: Map<string, number[]>,
  cfg: VolTargetConfig,
): number | undefined {
  const n = closesByTicker.size;
  if (n === 0) return undefined;
  const dates = [...closesByTicker.values()].map((a) => a.length);
  const minLen = Math.min(...dates);
  if (minLen < cfg.lookbackDays + 1) return undefined;
  const rets: number[] = [];
  for (let i = minLen - cfg.lookbackDays; i < minLen; i++) {
    let ok = true;
    for (const arr of closesByTicker.values()) {
      const prev = arr[i - 1];
      const cur = arr[i];
      if (prev === undefined || cur === undefined || prev <= 0) {
        ok = false;
        break;
      }
    }
    // 等权：逐标的收益取平均（对价格求和取比值是价格加权，权重偏向高价股）
    if (ok) {
      let acc = 0;
      for (const arr of closesByTicker.values()) acc += (arr[i] as number) / (arr[i - 1] as number) - 1;
      rets.push(acc / n);
    }
  }
  if (rets.length < Math.max(10, cfg.lookbackDays * 0.6)) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1);
  const realized = Math.sqrt(variance * 252);
  return realized > 0 ? clamp(cfg.targetVol / realized, cfg.floor, cfg.ceiling) : undefined;
}

/** 最新估值偏移：用全部可得 CAPE 历史（截断到 lookbackYears） */
export function latestValuationTilt(cape: Point[], cfg: ValuationConfig): number | undefined {
  if (!cape.length) return undefined;
  const hist = cape.slice(-cfg.lookbackYears * 12);
  const pctile = percentileRank(hist.map((p) => p.value), hist.at(-1)?.value ?? 0);
  return clamp((0.5 - pctile) * 2, -1, 1) * cfg.maxTilt;
}
