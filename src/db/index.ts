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
      run_id integer,
      date date not null,
      ticker text not null,
      units_delta double precision not null,
      notional_usdt double precision not null,
      reason text not null
    );
    create table if not exists regime_points (
      run_id integer not null,
      date date not null,
      score double precision not null,
      regime text not null,
      equity_target double precision not null,
      signals jsonb not null,
      primary key (run_id, date)
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
    -- 已有旧表的增量迁移（幂等）
    alter table trades add column if not exists run_id integer;
    create table if not exists portfolio_state (
      mode text not null,
      ticker text not null,
      units double precision not null default 0,
      updated_at timestamptz not null default now(),
      primary key (mode, ticker)
    );
    create table if not exists earnings_dates (
      ticker text not null,
      earnings_date date not null,
      primary key (ticker, earnings_date)
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

/** 分块插入，避开 postgres 65535 参数上限 */
export async function saveRegimePoints(
  runId: number,
  timeline: { date: string; score: number; regime: string; equityTarget: number; signals: { liquidity: number; volatility: number; rates: number; trend: number } }[],
): Promise<void> {
  const db = getPool();
  const CHUNK = 8000;
  for (let i = 0; i < timeline.length; i += CHUNK) {
    const chunk = timeline.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((p, j) => {
      values.push(runId, p.date, p.score, p.regime, p.equityTarget, JSON.stringify(p.signals));
      return `($${j * 6 + 1}, $${j * 6 + 2}, $${j * 6 + 3}, $${j * 6 + 4}, $${j * 6 + 5}, $${j * 6 + 6}::jsonb)`;
    });
    await db.query(
      `insert into regime_points (run_id, date, score, regime, equity_target, signals) values ${tuples.join(",")}
       on conflict (run_id, date) do update set score = excluded.score, regime = excluded.regime, equity_target = excluded.equity_target, signals = excluded.signals`,
      values,
    );
  }
}

export async function saveTrades(
  runId: number,
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; reason: string }[],
): Promise<void> {
  const db = getPool();
  const CHUNK = 8000; // 每行 6 个参数，8000 行 = 48,000 < 65,535 上限
  for (let i = 0; i < trades.length; i += CHUNK) {
    const chunk = trades.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((t, j) => {
      values.push(runId, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, t.reason);
      const b = j * 6;
      return `('backtest', $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await db.query(
      `insert into trades (mode, run_id, date, ticker, units_delta, notional_usdt, reason) values ${tuples.join(",")}`,
      values,
    );
  }
}

export async function latestRunId(): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>("select id from backtest_runs order by id desc limit 1");
  return rows[0]?.id ?? null;
}

/* ---------- 执行器（paper/live 共用） ---------- */

export interface Position {
  ticker: string;
  units: number;
}

export async function loadPortfolio(mode: string): Promise<{ positions: Map<string, number>; cash: number }> {
  const { rows } = await getPool().query<{ ticker: string; units: string }>(
    "select ticker, units from portfolio_state where mode = $1",
    [mode],
  );
  const positions = new Map<string, number>();
  let cash = 0;
  for (const r of rows) {
    if (r.ticker === "CASH") cash = Number(r.units);
    else positions.set(r.ticker, Number(r.units));
  }
  return { positions, cash };
}

export async function savePortfolio(mode: string, positions: Map<string, number>, cash: number): Promise<void> {
  const db = getPool();
  const entries: [string, number][] = [...positions, ["CASH", cash]];
  for (const [ticker, units] of entries) {
    await db.query(
      `insert into portfolio_state (mode, ticker, units, updated_at) values ($1, $2, $3, now())
       on conflict (mode, ticker) do update set units = excluded.units, updated_at = now()`,
      [mode, ticker, units],
    );
  }
}

/** 每只标的的最新可得收盘价（step-carry 语义由调用方决定，此处直接取最近一行） */
export async function latestPrices(tickers: string[]): Promise<Map<string, number>> {
  const { rows } = await getPool().query<{ ticker: string; close: number }>(
    `select distinct on (ticker) ticker, close from prices
     where ticker = any($1) order by ticker, date desc`,
    [tickers],
  );
  return new Map(rows.map((r) => [r.ticker, r.close]));
}

export async function upsertEarningsDates(rows: { ticker: string; date: string }[]): Promise<void> {
  if (!rows.length) return;
  const db = getPool();
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.ticker, r.date);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  });
  await db.query(
    `insert into earnings_dates (ticker, earnings_date) values ${tuples.join(",")}
     on conflict (ticker, earnings_date) do nothing`,
    values,
  );
}

/** 指定日期之后（含当天）的财报日，按标的分组（to_char 避免 TZ 偏移） */
export async function upcomingEarnings(tickers: string[], asOf: string): Promise<Map<string, string[]>> {
  const { rows } = await getPool().query<{ ticker: string; d: string }>(
    `select ticker, to_char(earnings_date, 'YYYY-MM-DD') as d from earnings_dates
     where ticker = any($1) and earnings_date >= $2 order by ticker, earnings_date`,
    [tickers, asOf],
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    let list = out.get(r.ticker);
    if (!list) out.set(r.ticker, (list = []));
    list.push(r.d);
  }
  return out;
}

export async function recordTrades(
  mode: string,
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; reason: string }[],
): Promise<void> {
  for (const t of trades) {
    await getPool().query(
      "insert into trades (mode, date, ticker, units_delta, notional_usdt, reason) values ($1, $2, $3, $4, $5, $6)",
      [mode, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, t.reason],
    );
  }
}
