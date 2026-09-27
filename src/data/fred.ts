import { parseFredCsv, type Point } from "./stats.js";
import type { MacroBundle } from "../strategy/regime.js";

/**
 * FRED 宏观数据源：https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES_ID>
 * 无需 API key，直连可用（2026-09-26 在本机网络已验证）。
 */
const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

export const MACRO_SERIES = {
  liquidity: "WALCL", // 美联储资产负债表（周频，百万美元）
  volatility: "VIXCLS", // VIX 收盘（日频）
  rates: "DGS10", // 10 年期国债收益率（日频）
  trend: "SP500", // 标普 500 指数（日频，FRED 保留近 10 年）
} as const;

export type MacroKey = keyof typeof MACRO_SERIES;

export async function fetchFredSeries(id: string, timeoutMs = 20_000): Promise<Point[]> {
  const res = await fetch(FRED_CSV + id, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`FRED 请求失败 ${res.status}: ${id}`);
  return parseFredCsv(await res.text());
}

/**
 * 数据新鲜度上限（日历日）：某序列最新观测值落后主日历（SP500）超过此值即视为断供。
 * 依据 2026-09-27 实测：尾部滞后 WALCL 2d / VIXCLS 3d / DGS10 1d，而各自历史
 * 观测间隔的最大值是 WALCL 7d（周频恒定）、VIXCLS 7d、DGS10 5d、SP500 4d。
 * 14 天是"最坏正常间隔的两倍"，宁可误报也不让过期百分位进决策路径。
 */
export const MAX_SERIES_LAG_DAYS = 14;

/** 主日历至少要有这么多个共同交易日才允许出信号（对齐 invest-platform 的 SyncError 口径） */
export const MIN_OVERLAP_DAYS = 60;

export class MacroDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroDataError";
  }
}

const lagDays = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * 完整性守卫：任一宏观序列断供或与主日历重叠不足即硬失败。
 *
 * 为什么必须是错误而不是回落：体制时间线里每个交易日的百分位都取"该序列自身最近的
 * 尾部窗口"，序列停更时 computeRegimeTimeline 只是算不到那几天，最新可用点于是静默
 * 停在几周前——执行器拿的仍是"最新点"，看不出任何异常，却用一份过期的分布做仓位决策。
 */
export function validateMacroBundle(bundle: MacroBundle): void {
  const calendar = bundle.trend;
  const end = calendar.at(-1)?.date;
  if (!end) throw new MacroDataError("主日历 SP500 为空：FRED 未返回任何观测值");
  const calendarDates = new Set(calendar.map((p) => p.date));

  for (const key of ["liquidity", "volatility", "rates"] as const) {
    const series = bundle[key];
    const id = MACRO_SERIES[key];
    const lastDate = series.at(-1)?.date;
    if (!lastDate) throw new MacroDataError(`宏观序列 ${id} (${key}) 为空`);
    const lag = lagDays(end, lastDate);
    if (lag > MAX_SERIES_LAG_DAYS) {
      throw new MacroDataError(
        `宏观序列 ${id} (${key}) 疑似断供：最新观测 ${lastDate} 落后 SP500 ${lag} 天（阈值 ${MAX_SERIES_LAG_DAYS}）。` +
          `继续运行会用截至该日的过期百分位做仓位决策。`,
      );
    }
    const overlap = series.filter((p) => calendarDates.has(p.date)).length;
    if (overlap < MIN_OVERLAP_DAYS) {
      throw new MacroDataError(`宏观序列 ${id} (${key}) 与 SP500 只有 ${overlap} 个共同交易日（阈值 ${MIN_OVERLAP_DAYS}）`);
    }
  }
}

/** 拉齐四个宏观序列，并当场做完整性检查 */
export async function fetchMacroBundle(): Promise<Record<MacroKey, Point[]>> {
  const results = await Promise.all(
    Object.entries(MACRO_SERIES).map(async ([key, id]) => [key, await fetchFredSeries(id)] as const),
  );
  const bundle = Object.fromEntries(results) as Record<MacroKey, Point[]>;
  validateMacroBundle(bundle);
  return bundle;
}
