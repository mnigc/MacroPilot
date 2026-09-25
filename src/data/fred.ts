import { parseFredCsv, type Point } from "./stats.js";

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

/** 拉齐四个宏观序列 */
export async function fetchMacroBundle(): Promise<Record<MacroKey, Point[]>> {
  const results = await Promise.all(
    Object.entries(MACRO_SERIES).map(async ([key, id]) => [key, await fetchFredSeries(id)] as const),
  );
  return Object.fromEntries(results) as Record<MacroKey, Point[]>;
}
