export interface Point {
  date: string; // YYYY-MM-DD
  value: number;
}

/** 尾随窗口百分位（0~1）：当前值在历史分布中的位置，对量纲和离群值稳健 */
export function percentileRank(history: number[], x: number): number {
  if (history.length === 0) return 0.5;
  let count = 0;
  for (const v of history) if (v <= x) count++;
  return count / history.length;
}

/** 按序列自身位置计算对 lag 个交易日前的变化（序列内部位置，非自然日） */
export function changeOver(series: Point[], lag: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = lag; i < series.length; i++) {
    const prev = series[i - lag];
    const cur = series[i];
    if (!prev || !cur || prev.value === 0) continue;
    out.set(cur.date, cur.value / prev.value - 1);
  }
  return out;
}

export function changeAbs(series: Point[], lag: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = lag; i < series.length; i++) {
    const prev = series[i - lag];
    const cur = series[i];
    if (!prev || !cur) continue;
    out.set(cur.date, cur.value - prev.value);
  }
  return out;
}

/** 简单移动平均，按序列位置 */
export function sma(series: Point[], window: number): Map<string, number> {
  const out = new Map<string, number>();
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    if (!cur) continue;
    sum += cur.value;
    const dropped = series[i - window];
    if (i >= window && dropped) sum -= dropped.value;
    if (i >= window - 1) out.set(cur.date, sum / window);
  }
  return out;
}

/**
 * 把不规则频率序列（如周频 WALCL）对齐到交易日日历：
 * 每个日历日取"该日或该日之前最近一次观测值"（step carry）。
 * calendar 与 series 都需升序。
 */
export function alignToCalendar(series: Point[], calendar: string[]): (number | undefined)[] {
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  const out: (number | undefined)[] = [];
  let last: number | undefined;
  for (const d of calendar) {
    const v = byDate.get(d);
    if (v !== undefined) last = v;
    out.push(last);
  }
  return out;
}

/** 解析 FRED fredgraph.csv；假日等为空值（"date,"）或 "."，一律跳过。注意 Number("") === 0，必须先排除空串 */
export function parseFredCsv(csv: string): Point[] {
  const lines = csv.trim().split(/\r?\n/);
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [date, raw] = line.split(",");
    const value = Number(raw);
    if (date && raw !== undefined && raw !== "" && raw !== "." && Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}
