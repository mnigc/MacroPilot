export interface BacktestMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  /** 年化波动率（日收益标准差 × √252） */
  annualVol: number;
  /** 累计交易成本占平均净值的比例（回测腿填，其他场景可缺省） */
  turnoverPct?: number;
}

/** 从日频净值曲线计算标准指标 */
export function computeMetrics(equity: { date: string; value: number }[]): BacktestMetrics {
  const firstPoint = equity[0];
  const lastPoint = equity[equity.length - 1];
  if (!firstPoint || !lastPoint || equity.length < 2) {
    return { totalReturn: 0, cagr: 0, maxDrawdown: 0, sharpe: 0, annualVol: 0 };
  }
  const first = firstPoint.value;
  const last = lastPoint.value;
  const totalReturn = last / first - 1;

  const days = daysBetween(firstPoint.date, lastPoint.date);
  const years = days / 365.25;
  const cagr = years > 0.25 ? Math.pow(last / first, 1 / years) - 1 : totalReturn;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    const dd = p.value / peak - 1;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (prev && cur && prev.value > 0) rets.push(cur.value / prev.value - 1);
  }
  const { mean, std } = meanStd(rets);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const annualVol = std * Math.sqrt(252);

  return { totalReturn, cagr, maxDrawdown, sharpe, annualVol };
}

export function meanStd(xs: number[]): { mean: number; std: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, std: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1);
  return { mean, std: Math.sqrt(variance) };
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/** 月度收益矩阵：年 → [1~12 月收益率]（月末日对月末日），缺月为 null */
export function monthlyReturns(equity: { date: string; value: number }[]): { year: string; months: (number | null)[] }[] {
  const monthEnd = new Map<string, { date: string; value: number }>();
  for (const p of equity) monthEnd.set(p.date.slice(0, 7), p); // 同月最后一条覆盖
  const keys = [...monthEnd.keys()].sort();
  const byYear = new Map<string, (number | null)[]>();
  let prev: { key: string; value: number } | null = null;
  for (const key of keys) {
    const point = monthEnd.get(key) as { date: string; value: number };
    const year = key.slice(0, 4);
    const mon = Number(key.slice(5, 7)) - 1;
    if (!byYear.has(year)) byYear.set(year, Array<number | null>(12).fill(null));
    const row = byYear.get(year) as (number | null)[];
    if (prev && prev.value > 0) row[mon] = point.value / prev.value - 1;
    prev = { key, value: point.value };
  }
  return [...byYear.entries()].map(([year, months]) => ({ year, months }));
}

/** 滚动年化夏普（window 个交易日，默认 252） */
export function rollingSharpe(equity: { date: string; value: number }[], window = 252): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const rets: number[] = [];
  const dates: string[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (!prev || !cur || prev.value <= 0) continue;
    rets.push(cur.value / prev.value - 1);
    dates.push(cur.date);
  }
  for (let i = window; i < rets.length; i++) {
    const win = rets.slice(i - window, i + 1);
    const { mean, std } = meanStd(win);
    out.push({ date: dates[i] as string, value: std > 0 ? (mean / std) * Math.sqrt(252) : 0 });
  }
  return out;
}
