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
  metrics: { strategy: RunMetrics; benchmark: RunMetrics; benchmark6040?: RunMetrics };
  regime_days: Record<string, number>;
  final_weights: Record<string, number>;
  equity: { strategy: ChartPoint[]; benchmark: ChartPoint[]; benchmark6040?: ChartPoint[] };
}

export interface RunMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  annualVol?: number;
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
  signals: { liquidity: number; volatility: number; rates: number; trend: number; credit?: number };
}

export interface TradeRow {
  mode: string;
  date: string;
  ticker: string;
  units_delta: number;
  notional_usdt: number;
  reason: string;
  /**
   * 落库时刻（UTC，MM-DD HH:MM:SS）。paper 下它同时是成交时刻——一轮跑完即写库；
   * **backtest 下它没有意义**（8508 行是回填时一次性插入的，时刻全落在回填那一分钟），
   * 所以界面只在 paper 流水里显示这一列。
   */
  createdAt?: string;
  /** 该笔计提的单边成本（美元）；2026-09-28 之前的记录为 0 */
  costUsdt?: number;
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
      `select mode, to_char(date, 'YYYY-MM-DD') as date, ticker, units_delta, notional_usdt, reason,
              coalesce(cost_usdt, 0)::float as "costUsdt",
              to_char(created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as "createdAt"
       from trades where mode = $1 order by date desc, created_at desc, id desc limit $2`,
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

/**
 * 一次性拿到整轮回测的成交额拆分。换手率必须从库里聚合，不能走 getTrades——
 * 那个函数有 limit，而 run #14 有 2202 笔，截断后算出的换手会悄悄偏小。
 */
export interface Turnover {
  /** Σ|成交额|，双边口径 */
  gross: number;
  fills: number;
  buys: number;
  sells: number;
}

export async function getBacktestTurnover(runId: number): Promise<Turnover | null> {
  return cached(`turnover:${runId}`, async () => {
    const { rows } = await db.query<Turnover>(
      `select coalesce(sum(abs(notional_usdt)), 0)::float as gross,
              count(*)::int as fills,
              coalesce(sum(case when units_delta > 0 then notional_usdt else 0 end), 0)::float as buys,
              coalesce(sum(case when units_delta < 0 then abs(notional_usdt) else 0 end), 0)::float as sells
       from trades where mode = 'backtest' and run_id = $1`,
      [runId],
    );
    return rows[0] ?? null;
  });
}

export interface BoardRow {
  ticker: string;
  date: string;
  close: number;
  prevClose: number | null;
}

/** 行情条：每股最新收盘价与较前一交易日的涨跌 */
export async function getTickerBoard(tickers: string[]): Promise<BoardRow[]> {
  return cached(`board:${tickers.join(",")}`, async () => {
    const { rows } = await db.query<BoardRow>(
      `with r as (
         select ticker, date::text as d, close,
                row_number() over (partition by ticker order by date desc) rn
         from prices where ticker = any($1)
       )
       select a.ticker, a.d as date, a.close, b.close as "prevClose"
       from r a
       left join r b on b.ticker = a.ticker and b.rn = 2
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
      [["WALCL", "VIXCLS", "DGS10", "SP500", "BAMLH0A0HYM2", "UNRATE"]],
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

export interface ExecutorRun {
  /** 最近一轮执行写入 runtime_state 的时刻（UTC，ISO 带 Z，便于直接算距今）——每轮都会 upsert，等于心跳 */
  at: string;
  /** 那一轮据以决策的数据日 */
  asOf: string;
}

/**
 * 执行器心跳。runtime_state 每轮都会写，所以它的 updated_at 就是"上次真正跑完一轮"的时刻；
 * 若某轮在守卫处硬失败（如宏观序列断供），这里会停在上一轮——这正是要显示的信号，
 * 而不是拿股价的 as_of 冒充"执行器刚刚跑过"。
 */
export async function getExecutorRun(mode: string): Promise<ExecutorRun | null> {
  return cached(`executorRun:${mode}`, async () => {
    const { rows } = await db.query<ExecutorRun>(
      `select to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "at",
              max(as_of)::text as "asOf"
       from runtime_state where mode = $1`,
      [mode],
    );
    const r = rows[0];
    return r?.at ? r : null;
  });
}

export interface Freshness {
  prices: { asOf: string | null; tickers: number };
  /** 宏观时间线的最后一个交易日——FRED 滞后于股价，这个日期通常比 prices 旧 */
  macro: { asOf: string | null; runId: number | null };
  /** asOf 是决策依据的数据日，at 是执行器真正写入心跳的时刻（UTC，含时分秒） */
  agent: { asOf: string | null; at: string | null; mode: string | null };
}

/**
 * 各数据源各自的"截至日"。FRED 序列比股价慢、股价比执行器慢，把它们混成一个
 * "最近更新"会误导判读，所以逐源报告、由界面按滞后天数着色。
 */
export async function getFreshness(): Promise<Freshness> {
  return cached("freshness", async () => {
    const [prices, macro, agent] = await Promise.all([
      db.query<{ asOf: string | null; n: string }>(
        `select max(date)::text as "asOf", count(distinct ticker)::text as n from prices`,
      ),
      db.query<{ asOf: string | null; run: number | null }>(
        `select to_char(max(date), 'YYYY-MM-DD') as "asOf", max(run_id) as run
         from regime_points where run_id = (select max(id) from backtest_runs)`,
      ),
      db.query<{ asOf: string | null; at: string | null; mode: string | null }>(
        `select to_char(max(as_of), 'YYYY-MM-DD') as "asOf",
                to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "at",
                max(mode) as mode from runtime_state`,
      ),
    ]);
    return {
      prices: { asOf: prices.rows[0]?.asOf ?? null, tickers: Number(prices.rows[0]?.n ?? 0) },
      macro: { asOf: macro.rows[0]?.asOf ?? null, runId: macro.rows[0]?.run ?? null },
      agent: { asOf: agent.rows[0]?.asOf ?? null, at: agent.rows[0]?.at ?? null, mode: agent.rows[0]?.mode ?? null },
    };
  });
}

/* ---------- 消融实验 / 统计产物 / 执行预告 / 真实账本对照 ---------- */

export interface AblationRow {
  id: number;
  variant: string;
  params: Record<string, unknown>;
  metrics: { strategy: RunMetrics; benchmark: RunMetrics; benchmark6040?: RunMetrics };
}

/** 最近一批消融实验（同 batchId 的全部变体），按入库序排列——消融表按"逐层叠加"读差值 */
export async function getAblationCohort(): Promise<AblationRow[]> {
  return cached("ablation", async () => {
    const { rows } = await db.query<AblationRow>(
      `select id, variant, params, metrics from backtest_runs
       where variant is not null
         and params->>'batchId' = (
           select params->>'batchId' from backtest_runs
           where variant is not null and params->>'batchId' is not null
           order by id desc limit 1
         )
       order by id`,
    );
    return rows;
  });
}

/** 回测统计产物（月度矩阵/滚动夏普/自助法/扇形/类比/敏感性/walkforward） */
export async function getArtifact<T>(runId: number, kind: string): Promise<T | null> {
  return cached(`artifact:${runId}:${kind}`, async () => {
    const { rows } = await db.query<{ data: T }>("select data from run_artifacts where run_id = $1 and kind = $2", [runId, kind]);
    return rows[0]?.data ?? null;
  });
}

export interface ExecutorPreview {
  asOf: string;
  regime: string;
  score: number;
  sahm: number | null;
  gateActive: boolean;
  composition: { regimeTarget: number; volMult: number | null; tilt: number | null; final: number };
  equity: number;
  drifts: { ticker: string; driftPp: number; thresholdPp: number }[];
  nextFriday: { date: string; injectionUsdt: number; planned: { ticker: string; usdt: number }[] } | null;
  earningsNext14d: { ticker: string; date: string }[];
}

export async function getExecutorPreview(mode: string): Promise<ExecutorPreview | null> {
  return cached(`preview:${mode}`, async () => {
    const { rows } = await db.query<{ data: ExecutorPreview }>("select data from executor_preview where mode = $1", [mode]);
    return rows[0]?.data ?? null;
  });
}

export interface RealVsPaperRow {
  date: string;
  ticker: string;
  units_delta: number;
  realPx: number;
  paperClose: number;
}

/** 真实成交 vs 同日纸面收盘：真实滑点的直接证据（真实成交价 − 当日收盘参考价） */
export async function getRealVsPaper(): Promise<RealVsPaperRow[]> {
  return cached("realVsPaper", async () => {
    const { rows } = await db.query<RealVsPaperRow>(
      `select to_char(t.date, 'YYYY-MM-DD') as date, t.ticker, t.units_delta,
              (t.notional_usdt / nullif(abs(t.units_delta), 0))::float as "realPx",
              p.close as "paperClose"
       from trades t
       join prices p on p.ticker = t.ticker and p.date = t.date
       where t.mode = 'real'
       order by t.date desc, t.ticker
       limit 200`,
    );
    return rows;
  });
}
