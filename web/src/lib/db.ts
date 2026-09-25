import { Pool } from "pg";

/** 构建期/SSR 直读 Supabase Postgres。兼容 process.env 与 Vite 注入两种方式 */
const url = process.env.DATABASE_URL ?? (import.meta.env.DATABASE_URL as string | undefined);
if (!url) throw new Error("缺少 DATABASE_URL");

const db = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15_000 });
export { db };

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
  const { rows } = await db.query<RunRow>(
    "select id, generated_at, tickers, params, metrics, regime_days, final_weights, equity from backtest_runs order by id desc limit 1",
  );
  return rows[0] ?? null;
}

export async function getRegimePoints(runId: number): Promise<RegimePointRow[]> {
  const { rows } = await db.query<RegimePointRow>(
    "select to_char(date, 'YYYY-MM-DD') as date, score, regime, equity_target, signals from regime_points where run_id = $1 order by date",
    [runId],
  );
  return rows;
}

export async function getTrades(mode: string, limit = 100): Promise<TradeRow[]> {
  const { rows } = await db.query<TradeRow>(
    "select mode, to_char(date, 'YYYY-MM-DD') as date, ticker, units_delta, notional_usdt, reason from trades where mode = $1 order by date desc, id desc limit $2",
    [mode, limit],
  );
  return rows;
}

export async function getPortfolio(mode: string): Promise<{ ticker: string; units: number; updated_at: Date }[]> {
  const { rows } = await db.query<{ ticker: string; units: number; updated_at: Date }>(
    "select ticker, units, updated_at from portfolio_state where mode = $1 order by ticker",
    [mode],
  );
  return rows;
}

export async function getLatestPrices(tickers: string[]): Promise<Record<string, number>> {
  const { rows } = await db.query<{ ticker: string; close: number }>(
    `select distinct on (ticker) ticker, close from prices
     where ticker = any($1) order by ticker, date desc`,
    [tickers],
  );
  return Object.fromEntries(rows.map((r) => [r.ticker, r.close]));
}

export async function getUpcomingEarnings(tickers: string[], days = 60): Promise<{ ticker: string; earnings_date: string }[]> {
  const { rows } = await db.query<{ ticker: string; earnings_date: string }>(
    `select ticker, to_char(earnings_date, 'YYYY-MM-DD') as earnings_date from earnings_dates
     where ticker = any($1) and earnings_date between current_date and current_date + $2::int
     order by earnings_date`,
    [tickers, days],
  );
  return rows;
}
