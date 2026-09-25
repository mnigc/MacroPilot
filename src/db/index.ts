import { Pool } from "pg";
import type { Point } from "../data/stats.js";

/**
 * Supabase Postgres：价格、宏观数据缓存、回测结果、交易记录的持久层。
 * 连接串来自 .env 的 DATABASE_URL（该文件不入库）。
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("缺少 DATABASE_URL（参考 .env.example）");
    pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 15_000 });
  }
  return pool;
}

export async function initSchema(): Promise<void> {
  const db = getPool();
  await db.query(`
    create table if not exists prices (
      ticker text not null,
      date date not null,
      close double precision not null,
      primary key (ticker, date)
    );
    create table if not exists macro_observations (
      series text not null,
      date date not null,
      value double precision not null,
      primary key (series, date)
    );
    create table if not exists trades (
      id serial primary key,
      created_at timestamptz not null default now(),
      mode text not null,
      date date not null,
      ticker text not null,
      units_delta double precision not null,
      notional_usdt double precision not null,
      reason text not null
    );
    create table if not exists backtest_runs (
      id serial primary key,
      generated_at timestamptz not null default now(),
      tickers text[] not null,
      params jsonb not null,
      metrics jsonb not null,
      regime_days jsonb not null,
      final_weights jsonb not null,
      equity jsonb not null
    );
  `);
}

export async function loadPricesFromDb(): Promise<Map<string, Point[]>> {
  const { rows } = await getPool().query<{ ticker: string; date: Date; close: number }>(
    "select ticker, date, close from prices order by ticker, date",
  );
  const out = new Map<string, Point[]>();
  for (const row of rows) {
    let list = out.get(row.ticker);
    if (!list) out.set(row.ticker, (list = []));
    list.push({ date: row.date.toISOString().slice(0, 10), value: row.close });
  }
  return out;
}

export async function upsertPrices(ticker: string, points: Point[]): Promise<number> {
  if (!points.length) return 0;
  const db = getPool();
  const values: unknown[] = [];
  const tuples = points.map((p, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
  points.forEach((p, i) => values.push(ticker, p.date, p.value));
  const res = await db.query(
    `insert into prices (ticker, date, close) values ${tuples.join(",")}
     on conflict (ticker, date) do update set close = excluded.close`,
    values,
  );
  return res.rowCount ?? 0;
}

export interface BacktestRunRecord {
  tickers: string[];
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  regimeDays: Record<string, unknown>;
  finalWeights: Record<string, unknown>;
  equity: { strategy: Point[]; benchmark: Point[] };
}

export async function saveBacktestRun(rec: BacktestRunRecord): Promise<number> {
  const res = await getPool().query<{ id: number }>(
    `insert into backtest_runs (tickers, params, metrics, regime_days, final_weights, equity)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [rec.tickers, rec.params, rec.metrics, rec.regimeDays, rec.finalWeights, JSON.stringify(rec.equity)],
  );
  return res.rows[0]?.id ?? 0;
}
