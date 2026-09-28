import { Pool } from "pg";
import type { Point } from "../data/stats.js";
import { joinDrivers, type TradeDriver } from "../strategy/drivers.js";

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
    -- 逐笔成本（美元）：成本模型改为逐笔计算后，成本归因才有数据源
    alter table trades add column if not exists cost_usdt double precision default 0;
    -- 日成交量（股）：ADV 成本模型与流动性展示的数据源；历史行允许为 null（回填前）
    alter table prices add column if not exists volume double precision;
    -- 消融实验：同一批回测按引擎开关跑出多条 run，variant 标记各自配置
    alter table backtest_runs add column if not exists variant text;
    -- 回测附属产物（月度矩阵/滚动夏普/自助法/扇形/类比/敏感性），一份 JSON 一种 kind
    create table if not exists run_artifacts (
      run_id integer not null,
      kind text not null,
      data jsonb not null,
      primary key (run_id, kind)
    );
    -- 执行器的"下一轮预告"（确定性规则可提前算出下轮动作），每 mode 一份
    create table if not exists executor_preview (
      mode text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
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
    create table if not exists runtime_state (
      mode text primary key,
      regime text not null,
      equity_target double precision not null,
      score double precision not null,
      as_of date not null,
      updated_at timestamptz not null default now()
    );
  `);
}

/**
 * 按 ticker 取某日之后的美股日线收盘：ticker → (YYYY-MM-DD → close)。
 *
 * `since` 是必需的，不是优化：prices 里有 2000 年至今的全史，不带日期条件时单次要拉四万多行，
 * 在这条高延迟连接上会撞服务端 statement timeout（code 57014）。实测过一遍。
 */
export async function usClosesByTicker(tickers: string[], since: string): Promise<Map<string, Map<string, number>>> {
  const { rows } = await getPool().query<{ ticker: string; d: string; close: number }>(
    `select ticker, to_char(date, 'YYYY-MM-DD') as d, close from prices
     where ticker = any($1) and date >= $2::date`,
    [tickers, since],
  );
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = out.get(r.ticker);
    if (!m) out.set(r.ticker, (m = new Map()));
    m.set(r.d, r.close);
  }
  return out;
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

/** 收盘价 + 成交量一起取（ADV 成本模型需要）。volume 允许为 null（未回填的旧行）。
 *  按 ticker 逐只查询：全表一次拉 4 万+ 行会撞 Supabase 的服务端 statement timeout（57014），
 *  逐只拆成 7 个轻查询就稳——实测过一遍。 */
export async function loadPricesAndVolumesFromDb(tickers: string[]): Promise<{
  closes: Map<string, Point[]>;
  volumes: Map<string, Point[]>;
}> {
  const closes = new Map<string, Point[]>();
  const volumes = new Map<string, Point[]>();
  for (const ticker of tickers) {
    const { rows } = await getPool().query<{ date: Date; close: number; volume: number | null }>(
      "select date, close, volume from prices where ticker = $1 order by date",
      [ticker],
    );
    const cl: Point[] = [];
    const vl: Point[] = [];
    for (const row of rows) {
      const d = row.date.toISOString().slice(0, 10);
      cl.push({ date: d, value: row.close });
      if (row.volume !== null && Number.isFinite(row.volume) && row.volume > 0) vl.push({ date: d, value: row.volume });
    }
    if (cl.length) {
      closes.set(ticker, cl);
      if (vl.length) volumes.set(ticker, vl);
    }
  }
  return { closes, volumes };
}

/** ADV20（美元）：近 20 个交易日 成交量×收盘 的均值序列，供逐笔冲击成本用 */
export function computeAdvDollars(
  closes: Map<string, Point[]>,
  volumes: Map<string, Point[]>,
  window = 20,
): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const [t, closesList] of closes) {
    const volList = volumes.get(t);
    if (!volList?.length) continue;
    const volByDate = new Map(volList.map((p) => [p.date, p.value]));
    const dollar: Point[] = [];
    for (const p of closesList) {
      const v = volByDate.get(p.date);
      if (v !== undefined) dollar.push({ date: p.date, value: v * p.value });
    }
    const adv: Point[] = [];
    let sum = 0;
    for (let i = 0; i < dollar.length; i++) {
      sum += (dollar[i] as Point).value;
      const dropped = dollar[i - window];
      if (i >= window && dropped) sum -= dropped.value;
      if (i >= window - 1) adv.push({ date: (dollar[i] as Point).date, value: sum / Math.min(i + 1, window) });
    }
    out.set(t, adv);
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

/** 带成交量的价格 upsert（sync-prices.py 的 CSV → DB 导入）；volume 为 null 的行保留旧值 */
export async function upsertPriceRows(
  ticker: string,
  rows: { date: string; close: number; volume: number | null }[],
): Promise<number> {
  if (!rows.length) return 0;
  const db = getPool();
  const CHUNK = 6000; // 每行 3 参数
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      values.push(ticker, r.date, r.close, r.volume);
      return `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`;
    });
    const res = await db.query(
      `insert into prices (ticker, date, close, volume) values ${tuples.join(",")}
       on conflict (ticker, date) do update set close = excluded.close,
         volume = coalesce(excluded.volume, prices.volume)`,
      values,
    );
    total += res.rowCount ?? 0;
  }
  return total;
}

export interface BacktestRunRecord {
  tickers: string[];
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  regimeDays: Record<string, unknown>;
  finalWeights: Record<string, unknown>;
  equity: { strategy: Point[]; benchmark: Point[]; benchmark6040?: Point[] };
  /** 消融实验的配置标签（dca / +regime / full / …）；普通运行可缺省 */
  variant?: string;
}

export async function saveBacktestRun(rec: BacktestRunRecord): Promise<number> {
  const res = await getPool().query<{ id: number }>(
    `insert into backtest_runs (tickers, params, metrics, regime_days, final_weights, equity, variant)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [rec.tickers, rec.params, rec.metrics, rec.regimeDays, rec.finalWeights, JSON.stringify(rec.equity), rec.variant ?? null],
  );
  return res.rows[0]?.id ?? 0;
}

/** 回测附属产物：一份 JSON 一种 kind（monthly/rolling/bootstrap/fan/analog/sensitivity/walkforward） */
export async function saveArtifacts(
  runId: number,
  artifacts: { kind: string; data: unknown }[],
): Promise<void> {
  for (const a of artifacts) {
    await getPool().query(
      `insert into run_artifacts (run_id, kind, data) values ($1, $2, $3::jsonb)
       on conflict (run_id, kind) do update set data = excluded.data`,
      [runId, a.kind, JSON.stringify(a.data)],
    );
  }
}

/** 执行器"下一轮预告"：确定性规则可提前算出下轮动作，落库供站点展示 */
export async function saveExecutorPreview(mode: string, data: unknown): Promise<void> {
  await getPool().query(
    `insert into executor_preview (mode, data, updated_at) values ($1, $2::jsonb, now())
     on conflict (mode) do update set data = excluded.data, updated_at = now()`,
    [mode, JSON.stringify(data)],
  );
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
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; costUsd?: number; drivers: TradeDriver[] }[],
): Promise<void> {
  const db = getPool();
  const CHUNK = 8000; // 每行 7 个参数，8000 行 = 56,000 < 65,535 上限
  for (let i = 0; i < trades.length; i += CHUNK) {
    const chunk = trades.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((t, j) => {
      values.push(runId, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, joinDrivers(t.drivers), t.costUsd ?? 0);
      const b = j * 7;
      return `('backtest', $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
    });
    await db.query(
      `insert into trades (mode, run_id, date, ticker, units_delta, notional_usdt, reason, cost_usdt) values ${tuples.join(",")}`,
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

/** 每只标的的 ADV20（美元，近 20 个有成交量数据的交易日 成交量×收盘 均值）；无数据则缺项 */
export async function latestAdv(tickers: string[]): Promise<Map<string, number>> {
  const { rows } = await getPool().query<{ ticker: string; adv: number }>(
    `select ticker, avg(volume * close)::float as adv from (
       select ticker, volume, close, row_number() over (partition by ticker order by date desc) rn
       from prices where ticker = any($1) and volume is not null and volume > 0
     ) t where rn <= 20 group by ticker`,
    [tickers],
  );
  return new Map(rows.map((r) => [r.ticker, r.adv]));
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

/**
 * 财报日历覆盖情况。空表与"有历史但没有未来日期"是两种不同故障：
 * 前者引擎从未拿到数据，后者引擎会永远判定"无临近财报"。两者都必须能被前端区分展示。
 */
export async function earningsCalendarStatus(
  tickers: string[],
): Promise<{ rows: number; latest: string | null; upcoming: number }> {
  const { rows } = await getPool().query<{ n: string; latest: string | null; upcoming: string }>(
    `select count(*)::text as n,
            max(earnings_date)::text as latest,
            count(*) filter (where earnings_date >= current_date)::text as upcoming
     from earnings_dates where ticker = any($1)`,
    [tickers],
  );
  const r = rows[0];
  return { rows: Number(r?.n ?? 0), latest: r?.latest ?? null, upcoming: Number(r?.upcoming ?? 0) };
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

/** 全部历史财报日（含过去）——财报引擎进回测时判断"当日是否在财报窗口"用 */
export async function allEarningsByTicker(tickers: string[]): Promise<Map<string, string[]>> {
  const { rows } = await getPool().query<{ ticker: string; d: string }>(
    `select ticker, to_char(earnings_date, 'YYYY-MM-DD') as d from earnings_dates
     where ticker = any($1) order by ticker, earnings_date`,
    [tickers],
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
  trades: {
    date: string;
    ticker: string;
    unitsDelta: number;
    notionalUsdt: number;
    drivers: TradeDriver[];
    /** 逐笔成本（美元，单边）；未提供按 0 */
    costUsd?: number;
  }[],
): Promise<void> {
  for (const t of trades) {
    await getPool().query(
      "insert into trades (mode, date, ticker, units_delta, notional_usdt, reason, cost_usdt) values ($1, $2, $3, $4, $5, $6, $7)",
      [mode, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, joinDrivers(t.drivers), t.costUsd ?? 0],
    );
  }
}

/**
 * 执行器运行态：记录上一轮的体制与目标仓位，使本轮能判断"体制是否切换"——
 * 没有这份状态，执行器只能看到瞬时分数，归因里 regime 这一档永远不成立。
 */
export interface RuntimeState {
  regime: string;
  equityTarget: number;
  score: number;
  asOf: string;
}

export async function loadRuntimeState(mode: string): Promise<RuntimeState | null> {
  const { rows } = await getPool().query<RuntimeState>(
    "select regime, equity_target as \"equityTarget\", score, to_char(as_of, 'YYYY-MM-DD') as \"asOf\" from runtime_state where mode = $1",
    [mode],
  );
  return rows[0] ?? null;
}

export async function saveRuntimeState(mode: string, state: RuntimeState): Promise<void> {
  await getPool().query(
    `insert into runtime_state (mode, regime, equity_target, score, as_of, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (mode) do update set regime = excluded.regime, equity_target = excluded.equity_target,
       score = excluded.score, as_of = excluded.as_of, updated_at = now()`,
    [mode, state.regime, state.equityTarget, state.score, state.asOf],
  );
}

