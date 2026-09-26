import { Pool } from "pg";

/** 构建期/SSR 直读 Supabase Postgres。兼容 process.env 与 Vite 注入两种方式 */
const url = process.env.DATABASE_URL ?? (import.meta.env.DATABASE_URL as string | undefined);
if (!url) throw new Error("缺少 DATABASE_URL");

const db = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15_000 });
export { db };

/**
 * dev 模式每次请求都重跑页面查询，而 Supabase 在境外——不加缓存时每次刷新都要跨洋拉取
 * 大 JSONB（净值曲线 1700+ 点），页面延迟 25s+。构建期（生产路径）只执行一遍，缓存无副作用；
 * dev 下给 60 秒的新鲜度窗口。
 */
const queryCache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = 60_000): Promise<T> {
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  queryCache.set(key, { at: Date.now(), value });
  return value;
}

export interface RunRow {
  id: number;
  generated_at: Date;
  tickers: string[];
  params: Record<string, unknown>;
  metrics: { strategy: RunMetrics; benchmark: RunMetrics };
  regime_days: Record<string, number>;
  final_weights: Record<string, number>;
  equity: { strategy: ChartPoint[]; benchmark: ChartPoint[] };
}

export interface RunMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
}

export interface ChartPoint {
  date: string;
  value: number;
}

export interface RegimePointRow {
  date: string;
  score: number;
  regime: string;
  equity_target: number;
  signals: { liquidity: number; volatility: number; rates: number; trend: number };
}

export interface TradeRow {
  mode: string;
  date: string;
  ticker: string;
  units_delta: number;
  notional_usdt: number;
  reason: string;
}

export async function getLatestRun(): Promise<RunRow | null> {
  return cached("latestRun", async () => {
    const { rows } = await db.query<RunRow>(
      "select id, generated_at, tickers, params, metrics, regime_days, final_weights, equity from backtest_runs order by id desc limit 1",
    );
    return rows[0] ?? null;
  });
}

export async function getRegimePoints(runId: number): Promise<RegimePointRow[]> {
  return cached(`regimePoints:${runId}`, async () => {
    const { rows } = await db.query<RegimePointRow>(
      "select to_char(date, 'YYYY-MM-DD') as date, score, regime, equity_target, signals from regime_points where run_id = $1 order by date",
      [runId],
    );
    return rows;
  });
}

export async function getTrades(mode: string, limit = 100): Promise<TradeRow[]> {
  return cached(`trades:${mode}:${limit}`, async () => {
    const { rows } = await db.query<TradeRow>(
      "select mode, to_char(date, 'YYYY-MM-DD') as date, ticker, units_delta, notional_usdt, reason from trades where mode = $1 order by date desc, id desc limit $2",
      [mode, limit],
    );
    return rows;
  });
}

export async function getPortfolio(mode: string): Promise<{ ticker: string; units: number; updated_at: Date }[]> {
  return cached(`portfolio:${mode}`, async () => {
    const { rows } = await db.query<{ ticker: string; units: number; updated_at: Date }>(
      "select ticker, units, updated_at from portfolio_state where mode = $1 order by ticker",
      [mode],
    );
    return rows;
  });
}

export async function getLatestPrices(tickers: string[]): Promise<Record<string, number>> {
  return cached("latestPrices", async () => {
    const { rows } = await db.query<{ ticker: string; close: number }>(
      `select distinct on (ticker) ticker, close from prices
       where ticker = any($1) order by ticker, date desc`,
      [tickers],
    );
    return Object.fromEntries(rows.map((r) => [r.ticker, r.close]));
  });
}

export async function getUpcomingEarnings(tickers: string[], days = 60): Promise<{ ticker: string; earnings_date: string }[]> {
  return cached(`earnings:${days}`, async () => {
    const { rows } = await db.query<{ ticker: string; earnings_date: string }>(
      `select ticker, to_char(earnings_date, 'YYYY-MM-DD') as earnings_date from earnings_dates
       where ticker = any($1) and earnings_date between current_date and current_date + $2::int
       order by earnings_date`,
      [tickers, days],
    );
    return rows;
  });
}

export interface PremiumRow {
  ticker: string;
  symbol: string;
  platform: string;
  reference_price: number | null;
  mark_price: number | null;
  executable_price: number | null;
  premium: number | null;
  impact_pct: number | null;
  vendor: string | null;
  dex: string | null;
}

/**
 * 最近一轮"链上可成交溢价"快照。
 * 数据端点给的是发行方净值标记（tokenPrice ≡ 参考价 × 份额比），没有盘口；
 * 这里的 premium 来自聚合器询价出的可成交单价，才是真信号。
 */
export async function getLatestPremiums(): Promise<{ capturedAt: string; rows: PremiumRow[]; snapshots: number } | null> {
  return cached("latestPremiums", async () => {
    const head = await db.query<{ captured_at: Date; n: string }>(
      `select captured_at, count(*)::text as n from rwa_premiums group by captured_at order by captured_at desc limit 1`,
    );
    const first = head.rows[0];
    if (!first) return null;
    const { rows } = await db.query<PremiumRow>(
      `select ticker, symbol, platform, reference_price, mark_price, executable_price, premium, impact_pct, vendor, dex
       from rwa_premiums where captured_at = $1 order by premium desc nulls last`,
      [first.captured_at],
    );
    const total = await db.query<{ n: string }>("select count(distinct captured_at)::text as n from rwa_premiums");
    return { capturedAt: first.captured_at.toISOString(), rows, snapshots: Number(total.rows[0]?.n ?? 0) };
  });
}
