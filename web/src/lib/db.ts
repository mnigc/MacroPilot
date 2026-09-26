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
  /** paper 成交叠加的链上溢价；live 与 backtest 为 null（真实报价/回测口径里不含这一项） */
  premium?: number | null;
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
      "select mode, to_char(date, 'YYYY-MM-DD') as date, ticker, units_delta, notional_usdt, reason, premium from trades where mode = $1 order by date desc, id desc limit $2",
      [mode, limit],
    );
    return rows;
  });
}

/** 某次回测的全部成交（约 2.2k 行），标的 K 线的买卖点与 FIFO 成本都靠它 */
export async function getRunTrades(runId: number): Promise<TradeRow[]> {
  return cached(`runTrades:${runId}`, async () => {
    const { rows } = await db.query<TradeRow>(
      `select mode, to_char(date, 'YYYY-MM-DD') as date, ticker, units_delta, notional_usdt, reason
       from trades where mode = 'backtest' and run_id = $1 order by date, ticker`,
      [runId],
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

export interface BoardRow {
  ticker: string;
  date: string;
  close: number;
  prevClose: number | null;
  symbol: string | null;
  platform: string | null;
  premium: number | null;
  impactPct: number | null;
}

/**
 * 行情条：每股最新收盘价、较前一交易日涨跌、以及最近一轮链上可成交溢价。
 * 把三者放一行是刻意的——收盘价是"应该付多少"，溢价是"链上实际付多少"。
 */
export async function getTickerBoard(tickers: string[]): Promise<BoardRow[]> {
  return cached(`board:${tickers.join(",")}`, async () => {
    const { rows } = await db.query<BoardRow>(
      `with r as (
         select ticker, date::text as d, close,
                row_number() over (partition by ticker order by date desc) rn
         from prices where ticker = any($1)
       ),
       snap as (
         select distinct on (ticker) ticker, symbol, platform, premium, impact_pct
         from rwa_premiums order by ticker, captured_at desc
       )
       select a.ticker, a.d as date, a.close, b.close as "prevClose",
              s.symbol, s.platform, s.premium, s.impact_pct as "impactPct"
       from r a
       left join r b on b.ticker = a.ticker and b.rn = 2
       left join snap s on s.ticker = a.ticker
       where a.rn = 1
       order by a.ticker`,
      [tickers],
    );
    return rows;
  });
}

export interface MacroReading {
  series: string;
  asOf: string;
  value: number;
  /** 91 个自然日（≈13 周）前的读数，用于展示"在往哪个方向走" */
  prevQ: number | null;
  /** 200 日均线，仅日频序列有值；SP500 的趋势信号读的就是它 */
  sma200: number | null;
}

/**
 * 体制引擎四个信号的**原始读数**。百分位只说"相对过去 3 年偏高偏低"，
 * 评委和用户真正想问的是"VIX 现在到底多少、联储资产负债表在扩还是在缩"，
 * 所以百分位必须和裸数据并排显示，否则分数是个无法证伪的黑箱。
 */
export async function getMacroReadings(): Promise<Record<string, MacroReading>> {
  return cached("macroReadings", async () => {
    const { rows } = await db.query<MacroReading & { sma200: string | null; prevQ: string | null }>(
      `with latest as (
         select distinct on (series) series, date, value
         from macro_observations where series = any($1::text[])
         order by series, date desc
       )
       select l.series,
              to_char(l.date, 'YYYY-MM-DD') as "asOf",
              l.value,
              (select v2.value from macro_observations v2
                where v2.series = l.series and v2.date <= l.date - 91
                order by v2.date desc limit 1) as "prevQ",
              (select avg(v3.value) from
                 (select value from macro_observations v4
                   where v4.series = l.series and v4.date < l.date
                   order by v4.date desc limit 200) v3) as "sma200"
       from latest l`,
      [["WALCL", "VIXCLS", "DGS10", "SP500"]],
    );
    return Object.fromEntries(
      rows.map((r) => [r.series, { series: r.series, asOf: r.asOf, value: r.value, prevQ: r.prevQ === null ? null : Number(r.prevQ), sma200: r.sma200 === null ? null : Number(r.sma200) }]),
    );
  });
}

/**
 * 财报日历覆盖情况。"未来 60 天没有财报"和"日历根本没同步过"在界面上必须长得不一样——
 * 后者渲染成前者，就等于用一个假的安全信号盖住一个坏掉的数据源。
 */
export async function getEarningsCoverage(tickers: string[]): Promise<{ rows: number; latest: string | null; upcoming: number }> {
  return cached(`earningsCoverage:${tickers.join(",")}`, async () => {
    const { rows } = await db.query<{ n: string; latest: string | null; upcoming: string }>(
      `select count(*)::text as n,
              max(earnings_date)::text as latest,
              count(*) filter (where earnings_date >= current_date)::text as upcoming
       from earnings_dates where ticker = any($1)`,
      [tickers],
    );
    const r = rows[0];
    return { rows: Number(r?.n ?? 0), latest: r?.latest ?? null, upcoming: Number(r?.upcoming ?? 0) };
  });
}

export interface NextEarnings {
  ticker: string;
  date: string;
  daysAway: number;
}

/** 每只标的的未来第一场财报（含距今天数）——财报引擎的排程面板 */
export async function getNextEarnings(tickers: string[]): Promise<NextEarnings[]> {
  return cached(`nextEarnings:${tickers.join(",")}`, async () => {
    const { rows } = await db.query<NextEarnings>(
      `select ticker, to_char(min(earnings_date), 'YYYY-MM-DD') as date,
              (min(earnings_date) - current_date)::int as "daysAway"
       from earnings_dates where ticker = any($1) and earnings_date >= current_date
       group by ticker order by "daysAway"`,
      [tickers],
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

/**
 * 日线口径的溢价历史：链上 1d 收盘 ÷ 份额比 vs **同一天**的美股收盘。
 *
 * 与上面 getLatestPremiums 的询价口径是两条独立证据，不能并成一条线：
 * 那条读的是聚合器盘口（真能成交，但只有当下一个点、且只有几天快照），
 * 这条读的是官方分钟线聚出的日线（可回溯约一年，但没有盘口，算不出冲击成本）。
 * 只保留两边同日均有读数的日期 —— 链上 7×24、美股有休市，缺任何一边都除不出溢价。
 */
export interface PremiumHistoryRow {
  ticker: string;
  date: string;
  /** 链上价折算到每股（USDT） */
  onchain: number;
  /** 同日美股官方收盘参考价（USD） */
  reference: number;
  premium: number;
}

export async function getPremiumHistory(tickers: string[], days = 400): Promise<PremiumHistoryRow[]> {
  return cached(`premiumHistory:${tickers.join(",")}:${days}`, async () => {
    const { rows } = await db.query<PremiumHistoryRow>(
      `select c.ticker, to_char(c.date, 'YYYY-MM-DD') as date,
              c.close / nullif(c.share_ratio, 0) as onchain,
              p.close as reference,
              c.close / nullif(c.share_ratio, 0) / nullif(p.close, 0) - 1 as premium
       from rwa_candles c
       join prices p on p.ticker = c.ticker and p.date = c.date
       where c.ticker = any($1) and c.date >= current_date - $2::int
         and c.share_ratio > 0 and p.close > 0
       order by c.ticker, c.date`,
      [tickers, days],
    );
    return rows;
  });
}

/**
 * 最近一轮采集的官方分钟蜡烛（300 根 1 分钟）。库里唯一带 volume 的一路，
 * 所以它负责回答"链上到底有没有人在买卖"；溢价仍只看日线与询价两条口径。
 */
export interface TickRow {
  ticker: string;
  /** bar 开盘时间（epoch 毫秒）。源站按 bigint 返回，pg 驱动会给字符串，故在 SQL 里转 float8 */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  shareRatio: number;
  capturedAt: string;
}

export async function getLatestTicks(): Promise<TickRow[]> {
  return cached("latestTicks", async () => {
    const { rows } = await db.query<TickRow>(
      `select ticker, open_time::float8 as "openTime", open, high, low, close, volume, share_ratio as "shareRatio",
              to_char((select max(captured_at) from rwa_ticks) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as "capturedAt"
       from rwa_ticks order by ticker, open_time`,
    );
    return rows;
  });
}

/**
 * 累计链上溢价摩擦：账本按"参考价 × (1+溢价)"付出/收到现金，却仍按参考价给持仓估值，
 * 两者之差就是"在链上买美股"相对直接买美股的真实成本。逐笔算再合计：
 *   每股差额 = 参考价 × 溢价 = notional/(1+溢价) × 溢价
 * 买入记为成本（正），卖出记为收益（负），所以带上 units_delta 的符号。
 */
export async function getPremiumFriction(
  mode: string,
): Promise<{ usd: number; fills: number; notional: number } | null> {
  return cached(`premiumFriction:${mode}`, async () => {
    const { rows } = await db.query<{ usd: number | null; n: string; notional: number | null }>(
      `select coalesce(sum(case when units_delta > 0 then 1 else -1 end * notional_usdt * premium / (1 + premium)), 0)::float as usd,
              count(*)::text as n,
              coalesce(sum(notional_usdt), 0)::float as notional
       from trades where mode = $1 and premium is not null`,
      [mode],
    );
    const r = rows[0];
    const fills = Number(r?.n ?? 0);
    if (!fills) return null;
    return { usd: r?.usd ?? 0, fills, notional: r?.notional ?? 0 };
  });
}

export interface Freshness {
  prices: { asOf: string | null; tickers: number };
  /** 宏观时间线的最后一个交易日——FRED 滞后于股价，这个日期通常比 prices 旧 */
  macro: { asOf: string | null; runId: number | null };
  agent: { asOf: string | null; mode: string | null };
  premium: { capturedAt: string | null; snapshots: number };
}

/**
 * 各数据源各自的"截至日"。FRED 序列比股价慢、股价比执行器慢，把它们混成一个
 * "最近更新"会误导判读，所以逐源报告、由界面按滞后天数着色。
 */
export async function getFreshness(): Promise<Freshness> {
  return cached("freshness", async () => {
    const [prices, macro, agent, premium] = await Promise.all([
      db.query<{ asOf: string | null; n: string }>(
        `select max(date)::text as "asOf", count(distinct ticker)::text as n from prices`,
      ),
      db.query<{ asOf: string | null; run: number | null }>(
        `select to_char(max(date), 'YYYY-MM-DD') as "asOf", max(run_id) as run
         from regime_points where run_id = (select max(id) from backtest_runs)`,
      ),
      db.query<{ asOf: string | null; mode: string | null }>(
        `select to_char(max(as_of), 'YYYY-MM-DD') as "asOf", max(mode) as mode from runtime_state`,
      ),
      db.query<{ captured: string | null; n: string }>(
        "select max(captured_at)::text as captured, count(distinct captured_at)::text as n from rwa_premiums",
      ),
    ]);
    return {
      prices: { asOf: prices.rows[0]?.asOf ?? null, tickers: Number(prices.rows[0]?.n ?? 0) },
      macro: { asOf: macro.rows[0]?.asOf ?? null, runId: macro.rows[0]?.run ?? null },
      agent: { asOf: agent.rows[0]?.asOf ?? null, mode: agent.rows[0]?.mode ?? null },
      premium: {
        capturedAt: premium.rows[0]?.captured ? new Date(premium.rows[0].captured).toISOString() : null,
        snapshots: Number(premium.rows[0]?.n ?? 0),
      },
    };
  });
}
