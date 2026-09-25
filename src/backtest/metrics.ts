export interface BacktestMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
}

/** 从日频净值曲线计算标准指标 */
export function computeMetrics(equity: { date: string; value: number }[]): BacktestMetrics {
  const firstPoint = equity[0];
  const lastPoint = equity[equity.length - 1];
  if (!firstPoint || !lastPoint || equity.length < 2) {
    return { totalReturn: 0, cagr: 0, maxDrawdown: 0, sharpe: 0 };
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
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return { totalReturn, cagr, maxDrawdown, sharpe };
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}
