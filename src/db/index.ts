import { Pool } from "pg";
import type { Point } from "../data/stats.js";
import type { PremiumRow } from "../binance/premium.js";
import type { CandleRow, TickRow } from "../binance/candles.js";
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
    -- paper 成交所用的链上溢价（null = 该轮无快照或 live 真实成交）。没有这一列就无法事后回答
    -- "账面比回测少的那截，到底是溢价还是滑点"
    alter table trades add column if not exists premium double precision;
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
    -- 链上可成交溢价快照：数据端点的 tokenPrice 是净值标记（无盘口），溢价只能来自聚合器询价
    create table if not exists rwa_premiums (
      captured_at timestamptz not null,
      ticker text not null,
      symbol text not null,
      platform text not null default '',
      address text not null,
      reference_price double precision,
      mark_price double precision,
      executable_price double precision,
      premium double precision,
      impact_pct double precision,
      vendor text,
      dex text,
      primary key (captured_at, ticker)
    );
    -- 链上日线（公共 wallet-direct K 线）。与 rwa_premiums 的分工：询价只给"当下能不能成交"，
    -- 这张表给可回溯的价格序列（1d 口径约一年）。它没有成交量，所以只能画趋势不能当成交依据。
    -- 价格是**每枚代币**口径，要与美股每股参考价比必须除以 share_ratio；份额比逐日漂移，
    -- 所以把采集当时用到的比值一起存，历史溢价才能事后复算而不被后来的漂移污染。
    create table if not exists rwa_candles (
      ticker text not null,
      date date not null,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      share_ratio double precision not null default 1,
      captured_at timestamptz not null default now(),
      primary key (ticker, date)
    );
    -- 带成交量的 1 分钟蜡烛（签名 /dex/market/candles），源站最多给 300 根 ≈ 最近 5~6 小时。
    -- 粒度固定 1 分钟、limit 只决定根数，所以列里存的是每根 bar 自己的 open_time，
    -- 而缺掉的那些分钟就是"该分钟一笔成交都没有"——空洞率本身就是流动性读数。
    -- 它不参与溢价计算（没有对应的美股分钟价），只回答另一个问题：链上到底有没有人在真买卖，
    -- 还是只有一串净值标记 —— 顺带还给出"多少分钟一笔成交都没有"这个流动性读数。
    create table if not exists rwa_ticks (
      ticker text not null,
      open_time bigint not null,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      volume double precision not null default 0,
      share_ratio double precision not null default 1,
      captured_at timestamptz not null default now(),
      primary key (ticker, open_time)
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
  trades: { date: string; ticker: string; unitsDelta: number; notionalUsdt: number; drivers: TradeDriver[] }[],
): Promise<void> {
  const db = getPool();
  const CHUNK = 8000; // 每行 6 个参数，8000 行 = 48,000 < 65,535 上限
  for (let i = 0; i < trades.length; i += CHUNK) {
    const chunk = trades.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((t, j) => {
      values.push(runId, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, joinDrivers(t.drivers));
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

/**
 * 最近一轮链上可成交溢价。取"全局最新 captured_at"而不是每只标的各自的最新一行：
 * 混用相隔数天的报价会让同一轮的成交基准彼此不可比，而摩擦这个口径正要求同一把尺。
 * 溢价缺失（询价失败）的标的被略去，由调用方按 0 处理。
 *
 * 48 小时是硬截止：溢价采集只在用户本机跑（币安拦托管 runner 的出口 IP），关机过周末
 * 就会留下旧快照。旧溢价 × 新收盘价的混合比"没有溢价"更容易骗人，所以宁可退回参考价。
 */
export async function latestPremiums(
  tickers: string[],
): Promise<{ capturedAt: string | null; premiums: Map<string, number> }> {
  const { rows } = await getPool().query<{ t: string; ticker: string; premium: number | null }>(
    `select captured_at::text as t, ticker, premium from rwa_premiums
     where captured_at = (
       select max(captured_at) from rwa_premiums where captured_at > now() - interval '48 hours'
     ) and ticker = any($1)`,
    [tickers],
  );
  const premiums = new Map<string, number>();
  for (const r of rows) if (r.premium !== null) premiums.set(r.ticker, r.premium);
  return { capturedAt: rows[0]?.t ?? null, premiums };
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

export async function recordTrades(
  mode: string,
  trades: {
    date: string;
    ticker: string;
    unitsDelta: number;
    notionalUsdt: number;
    drivers: TradeDriver[];
    premium?: number | null;
  }[],
): Promise<void> {
  for (const t of trades) {
    await getPool().query(
      "insert into trades (mode, date, ticker, units_delta, notional_usdt, reason, premium) values ($1, $2, $3, $4, $5, $6, $7)",
      [mode, t.date, t.ticker, t.unitsDelta, t.notionalUsdt, joinDrivers(t.drivers), t.premium ?? null],
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

/**
 * 链上日线入库。一次 300 根、7 只标的 = 2100 行，逐行 insert 会把往返放大 2100 倍，
 * 所以拼成单条多值 upsert；重跑覆盖同一天，采集时间随批次刷新。
 */
export async function saveCandles(rows: CandleRow[]): Promise<number> {
  if (!rows.length) return 0;
  const db = getPool();
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.ticker, r.date, r.open, r.high, r.low, r.close, r.shareRatio);
    return `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`;
  });
  const res = await db.query(
    `insert into rwa_candles (ticker, date, open, high, low, close, share_ratio) values ${tuples.join(",")}
     on conflict (ticker, date) do update set open = excluded.open, high = excluded.high,
       low = excluded.low, close = excluded.close, share_ratio = excluded.share_ratio, captured_at = now()`,
    values,
  );
  return res.rowCount ?? 0;
}

/**
 * 1 分钟蜡烛入库。该端点只给"最近 300 根"、翻不出历史，所以这张表的定位是"最近一轮采集的镜像"：
 * 先按 ticker 清掉上一轮再写本轮，否则窗口滑走后旧 bar 会长留在表里，
 * 图上出现两段互不重叠的时间轴。删除与插入放进一个事务，中途失败不会留下半张表。
 */
export async function saveTicks(rows: TickRow[]): Promise<number> {
  if (!rows.length) return 0;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from rwa_ticks where ticker = any($1)", [
      Array.from(new Set(rows.map((r) => r.ticker))),
    ]);
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.ticker, r.openTime, r.open, r.high, r.low, r.close, r.volume, r.shareRatio);
      return `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`;
    });
    await client.query(
      `insert into rwa_ticks (ticker, open_time, open, high, low, close, volume, share_ratio) values ${tuples.join(",")}
       on conflict (ticker, open_time) do update set open = excluded.open, high = excluded.high,
         low = excluded.low, close = excluded.close, volume = excluded.volume,
         share_ratio = excluded.share_ratio, captured_at = now()`,
      values,
    );
    await client.query("commit");
    return rows.length;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 一轮溢价快照：同一 captured_at 下每个 ticker 一行（采集时刻由调用方决定，便于事后对齐） */
export async function savePremiumSnapshot(capturedAt: string, rows: PremiumRow[]): Promise<number> {
  if (!rows.length) return 0;
  const db = getPool();
  let n = 0;
  for (const r of rows) {
    const res = await db.query(
      `insert into rwa_premiums (captured_at, ticker, symbol, platform, address, reference_price, mark_price, executable_price, premium, impact_pct, vendor, dex)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (captured_at, ticker) do update set symbol = excluded.symbol, platform = excluded.platform,
         address = excluded.address, reference_price = excluded.reference_price, mark_price = excluded.mark_price,
         executable_price = excluded.executable_price, premium = excluded.premium, impact_pct = excluded.impact_pct,
         vendor = excluded.vendor, dex = excluded.dex`,
      [
        capturedAt,
        r.ticker,
        r.symbol,
        r.platform,
        r.address,
        r.referencePrice,
        r.markPrice,
        r.executablePrice,
        r.premium,
        r.impactPercent,
        r.vendor,
        r.dex,
      ],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}
