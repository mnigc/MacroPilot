import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { fetchMacroBundle, MACRO_SERIES } from "../data/fred.js";
import { computeRegimeTimeline, type MacroBundle, type RegimeConfig, type RegimePoint } from "../strategy/regime.js";
import { volMultiplierSeries, valuationTiltSeries, type ValuationConfig, type VolTargetConfig } from "../strategy/overlays.js";
import { computeAdvDollars, getPool, initSchema, loadPricesAndVolumesFromDb, upsertPrices } from "../db/index.js";
import { allEarningsByTicker } from "../db/index.js";
import { parseFredCsv, parsePriceCsv, type Point } from "../data/stats.js";

/**
 * 回测上下文装配：FRED 宏观 → 体制时间线；DB 价格/成交量 → ADV；财报全量；CAPE。
 * backtest / sweep / dry-run 预告共用这一份装配逻辑，保证所有消费方的口径一字不差。
 *
 * 装配即验证：宏观序列断供在这里就硬失败（fetchMacroBundle 内置守卫），
 * 价格缺失在这里就报错——不让任何下游拿到"看起来能跑"的残缺数据。
 */

export interface StrategyFile {
  basket: { tickers: string[] };
  engines: {
    dca: { enabled?: boolean; amountUsdt: number };
    regime: {
      scoreHigh: number;
      scoreLow: number;
      scoreRelease?: number;
      allocation: Record<string, number>;
      gate?: { sahmThreshold: number };
      signals: Record<string, { weight: number }>;
    };
    volTarget?: { enabled?: boolean; targetVol: number; lookbackDays: number; floor: number; ceiling: number; triggerPp: number };
    valuation?: { enabled?: boolean; maxTilt: number; lookbackYears: number; triggerPp: number };
    drift: { thresholdPp: number };
    earnings: { enabled?: boolean; riskOffDaysBefore: number; scaleFactor: number; restoreDaysAfter: number };
  };
  execution: {
    mode?: string;
    minTradeUsdt: number;
    slippagePercent: number;
    cashInterest?: boolean;
    startCashUsdt?: number;
    cost?: { halfSpreadBps: number; impactCoef: number; earningsMult: number };
  };
}

export function loadStrategyFile(path = "config/strategy.json"): StrategyFile {
  return JSON.parse(readFileSync(path, "utf8")) as StrategyFile;
}

export function regimeConfigOf(s: StrategyFile): RegimeConfig {
  const sig = s.engines.regime.signals;
  const w = {
    liquidity: sig.liquidity?.weight ?? 0.24,
    volatility: sig.volatility?.weight ?? 0.24,
    rates: sig.rates?.weight ?? 0.16,
    trend: sig.trend?.weight ?? 0.16,
    credit: sig.credit?.weight ?? 0.2,
  };
  return {
    weights: w,
    scoreHigh: s.engines.regime.scoreHigh,
    scoreLow: s.engines.regime.scoreLow,
    scoreRelease: s.engines.regime.scoreRelease ?? 0.45,
    allocation: {
      riskOn: s.engines.regime.allocation.riskOn ?? 1.0,
      neutral: s.engines.regime.allocation.neutral ?? 0.6,
      riskOff: s.engines.regime.allocation.riskOff ?? 0.25,
    },
    gate: s.engines.regime.gate ? { sahmThreshold: s.engines.regime.gate.sahmThreshold } : undefined,
  };
}

export function volTargetConfigOf(s: StrategyFile): VolTargetConfig & { enabled: boolean; triggerPp: number } {
  const v = s.engines.volTarget;
  return {
    enabled: v?.enabled ?? false,
    targetVol: v?.targetVol ?? 0.15,
    lookbackDays: v?.lookbackDays ?? 21,
    floor: v?.floor ?? 0.5,
    ceiling: v?.ceiling ?? 1.0,
    triggerPp: v?.triggerPp ?? 10,
  };
}

export function valuationConfigOf(s: StrategyFile): ValuationConfig & { enabled: boolean; triggerPp: number } {
  const v = s.engines.valuation;
  return {
    enabled: v?.enabled ?? false,
    maxTilt: v?.maxTilt ?? 0.15,
    lookbackYears: v?.lookbackYears ?? 20,
    triggerPp: v?.triggerPp ?? 5,
  };
}

export interface BacktestContext {
  bundle: MacroBundle;
  timeline: RegimePoint[];
  /** 收盘价（可能与时间线日历不同长度） */
  closes: Map<string, Point[]>;
  /** ADV20（美元），无成交量数据时为空表 */
  advDollars: Map<string, Point[]>;
  /** 全部历史财报日 */
  earningsByTicker: Map<string, string[]>;
  /** CAPE 月度序列；未同步时为空 */
  cape: Point[];
  /** 与时间线日历对齐的叠加层序列 */
  volMult: (number | undefined)[];
  tilt: (number | undefined)[];
  /** 数据可用性注记（页面/控制台展示用） */
  notes: string[];
  volCfg: VolTargetConfig & { enabled: boolean; triggerPp: number };
  valCfg: ValuationConfig & { enabled: boolean; triggerPp: number };
}

/** data/valuation/cape.csv（date,value 月度）——sync-valuation.py 的产物；缺失返回空 */
export function loadCape(): Point[] {
  const path = "data/valuation/cape.csv";
  if (!existsSync(path)) return [];
  const points = parseFredCsv(readFileSync(path, "utf8"));
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadBacktestContext(
  s: StrategyFile,
  opts: { withPrices?: boolean } = {},
): Promise<BacktestContext> {
  const { withPrices = true } = opts;
  await initSchema();
  const notes: string[] = [];

  const bundle = await fetchMacroBundle();
  const timeline = computeRegimeTimeline(bundle, regimeConfigOf(s));
  if (!timeline.length) throw new Error("体制时间线为空：宏观序列历史不足（每路需 ≥3 年）");

  // 宏观序列缓存入库（供前端信号图表复用）
  const db = getPool();
  for (const [key, id] of Object.entries(MACRO_SERIES)) {
    const points = bundle[key as keyof MacroBundle] as Point[] | undefined;
    if (!points?.length) continue;
    const values: unknown[] = [];
    const tuples = points.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
    points.forEach((p, i) => values.push(id, p.date, p.value));
    await db.query(
      `insert into macro_observations (series, date, value) values ${tuples.join(",")}
       on conflict (series, date) do update set value = excluded.value`,
      values,
    );
  }

  let closes = new Map<string, Point[]>();
  let advDollars = new Map<string, Point[]>();
  let earningsByTicker = new Map<string, string[]>();
  if (withPrices) {
    const loaded = await loadPricesAndVolumesFromDb(s.basket.tickers);
    closes = loaded.closes;
    if (!closes.size) {
      // CSV 兜底（Actions 同步的传输格式），导入 DB 后统一从 DB 读
      const { readdirSync } = await import("node:fs");
      const dir = "data/prices";
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".csv")) continue;
          const ticker = f.replace(".csv", "").toUpperCase();
          const points = parsePriceCsv(readFileSync(`${dir}/${f}`, "utf8"));
          if (points.length) {
            closes.set(ticker, points);
            await upsertPrices(ticker, points);
          }
        }
      }
    }
    const available = s.basket.tickers.filter((t) => (closes.get(t)?.length ?? 0) > 50);
    if (!available.length) throw new Error("无可用股价（DB 与 data/prices 均为空）——先运行同步");
    closes = new Map(available.map((t) => [t, closes.get(t) as Point[]]));
    advDollars = computeAdvDollars(closes, loaded.volumes);
    if (!advDollars.size) notes.push("无成交量数据：成本退回 flatBps，ADV 冲击模型未生效（跑一次 sync-prices.py 回填 volume）");

    earningsByTicker = await allEarningsByTicker(available);
    if (![...earningsByTicker.values()].some((d) => d.length))
      notes.push("财报日历为空：回测中财报引擎按关闭处理（sync-prices.py --earnings-only 可回填）");
    const firstTimelineDate = timeline[0]?.date ?? "9999";
    const histCoverage = Math.min(
      ...available.map((t) => (earningsByTicker.get(t) ?? []).filter((d) => d < firstTimelineDate).length),
    );
    if (histCoverage < 8) notes.push(`历史财报日覆盖不足（最少的一只仅 ${histCoverage} 条）：财报引擎在早期年份基本不触发`);
  }

  const cape = loadCape();
  if (!cape.length) notes.push("未找到 data/valuation/cape.csv：估值锚引擎按关闭处理（scripts/sync-valuation.py 可生成）");

  // 叠加层在"完整价格日历"上计算，再对齐到时间线日历——时间线从预热后才开始，
  // 直接在时间线上滚动会丢掉启动段的回看窗口
  const fullCalendar = bundle.trend.map((p) => p.date);
  const idxOf = new Map(fullCalendar.map((d, i) => [d, i]));
  const volCfg = volTargetConfigOf(s);
  const valCfg = valuationConfigOf(s);
  const volFull = volMultiplierSeries(closes, fullCalendar, volCfg);
  const tiltFull = valuationTiltSeries(cape, fullCalendar, valCfg);
  const volMult = timeline.map((p) => volFull[idxOf.get(p.date) as number]);
  const tilt = timeline.map((p) => tiltFull[idxOf.get(p.date) as number]);

  return { bundle, timeline, closes, advDollars, earningsByTicker, cape, volMult, tilt, notes, volCfg, valCfg };
}
