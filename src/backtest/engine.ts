import type { RegimePoint } from "../strategy/regime.js";
import type { TradeDriver } from "../strategy/drivers.js";
import { composeEquityTarget } from "../strategy/overlays.js";
import type { Point } from "../data/stats.js";

/**
 * 组合回测：与实盘执行器共用同一套目标权重合成逻辑。
 *
 * 目标仓位四层合成：体制档位（含 Sahm 门）× 波动率乘数 × (1+估值偏移) × (1+情绪偏移)，
 * 个股层再叠加财报缩放；每层引擎可独立开关——消融实验据此测出每一层的贡献。
 *
 * 成本模型（逐笔，不再是一刀切常数）：bps = 半价差 + impactCoef × √(名义额/ADV20)，
 * 财报窗口内成交乘 earningsMult（事件前后价差走阔）；无 ADV 数据时退回 flatBps。
 * 基准腿按同一模型计费，两腿待遇一致。
 *
 * 现金计息：现金筒按 DGS3MO 日频计息（年化/365），策略腿与两条基准腿同待遇——
 * 不计息会系统性惩罚 risk-off 期，等于低估策略的核心卖点。
 *
 * 基准两条：① Mag7 买入持有（首日等权买入永不调仓）；② 60/40（60% 篮子每月初
 * 再平衡 + 40% 现金计息）——后者是"最省事的替代方案"，策略必须连它一起赢。
 */

export interface CostModel {
  /** 半价差（基点，单边） */
  halfSpreadBps: number;
  /** 冲击系数：impactBps = impactCoef × √(名义额 / ADV$) × 10⁴ */
  impactCoef: number;
  /** 无 ADV 数据时的退回单边成本（基点） */
  flatBps: number;
  /** 财报窗口内成交的成本放大倍数 */
  earningsMult: number;
}

export interface EngineToggles {
  dca: boolean;
  regime: boolean;
  volTarget: boolean;
  valuation: boolean;
  sentiment: boolean;
  drift: boolean;
  earnings: boolean;
}

export interface BacktestConfig {
  tickers: string[];
  startCash: number;
  dcaUsdt: number; // 每周五注入；0 = 关闭定投
  driftThresholdPp: number;
  minTradeUsdt: number;
  cost: CostModel;
  engines: EngineToggles;
  /** 波动率乘数序列（与日历对齐）；关闭或数据缺失时按 1 处理 */
  volMult?: (number | undefined)[];
  /** 估值偏移序列（与日历对齐）；关闭或无 CAPE 时按 0 处理 */
  tilt?: (number | undefined)[];
  /** 情绪偏移序列（与日历对齐）；关闭或读数不足 minObs 时按 0 处理 */
  sentTilt?: (number | undefined)[];
  /** 波动率/估值/情绪乘数相对上次调仓的变化超过该百分点数才触发调仓并记驱动 */
  volTriggerPp: number;
  valueTriggerPp: number;
  sentTriggerPp: number;
  /** 财报引擎：窗口与缩放，以及全部历史财报日 */
  earnings: { daysBefore: number; daysAfter: number; scale: number };
  earningsByTicker: Map<string, string[]>;
  /** 现金年化利率序列（%，DGS3MO），按日 step-carry；缺失则不计息 */
  cashRate?: Point[];
  /** 每只标的的 ADV（美元，ADV20 = 近 20 个交易日 成交量×收盘 的均值），与日历同频 */
  advDollars?: Map<string, Point[]>;
}

export interface Trade {
  date: string;
  ticker: string;
  unitsDelta: number;
  notionalUsdt: number;
  /** 该笔计提的单边成本（美元）——成本归因从这里来 */
  costUsd: number;
  /** 触发本笔调仓的全部引擎（周五恰逢体制切换时两者皆记） */
  drivers: TradeDriver[];
}

export interface BacktestResult {
  calendar: string[];
  strategyEquity: { date: string; value: number }[];
  benchmarkEquity: { date: string; value: number }[];
  benchmark6040Equity: { date: string; value: number }[];
  trades: Trade[];
  regimeDays: Record<string, number>;
  finalWeights: Record<string, number>;
  /** 策略腿累计交易成本（美元） */
  costsPaid: number;
  /** 每日合成目标仓位（含全部叠加层）——消融归因与目标复现用 */
  targetSeries: { date: string; value: number }[];
}

/** 价格序列按日期 step-carry 取值（缺失日沿用最近收盘） */
function carryLookup(points: { date: string; value: number }[]): (date: string) => number | undefined {
  const map = new Map(points.map((p) => [p.date, p.value]));
  let last: number | undefined;
  const cache = new Map<string, number | undefined>();
  return (date: string) => {
    if (cache.has(date)) return cache.get(date);
    const v = map.get(date);
    if (v !== undefined) last = v;
    cache.set(date, last);
    return last;
  };
}

const isFriday = (date: string) => new Date(date + "T00:00:00Z").getUTCDay() === 5;

export function runBacktest(
  prices: Map<string, { date: string; value: number }[]>,
  regimeTimeline: RegimePoint[],
  cfg: BacktestConfig,
): BacktestResult {
  const calendar = regimeTimeline.map((p) => p.date);
  const lookup = new Map([...prices].map(([t, pts]) => [t, carryLookup(pts)]));
  const advAt = new Map([...(cfg.advDollars ?? [])].map(([t, pts]) => [t, carryLookup(pts)]));
  const cashRateAt = cfg.cashRate?.length ? carryLookup(cfg.cashRate) : undefined;

  let cash = cfg.startCash;
  const units = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));
  const trades: Trade[] = [];
  const strategyEquity: { date: string; value: number }[] = [];
  const benchmarkEquity: { date: string; value: number }[] = [];
  const benchmark6040Equity: { date: string; value: number }[] = [];
  const regimeDays: Record<string, number> = {};
  const targetSeries: { date: string; value: number }[] = [];
  let prevRegime: string | null = null;
  let prevGate = false;
  let totalCosts = 0;

  // 基准腿 ①：首日等权建仓，之后每周 DCA 等权加买，永不调仓
  const benchUnits = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));
  let benchCash = cfg.startCash;
  let benchSeeded = false;

  // 基准腿 ②：60/40，每月首个交易日再平衡，40% 现金计息
  const b40Units = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));
  let b40Cash = 0;
  let b40Seeded = false;
  let lastMonth = "";

  // 上次调仓时点的叠加层读数：驱动归因的比较基准
  let volMultAtRebalance: number | undefined;
  let tiltAtRebalance: number | undefined;
  let sentTiltAtRebalance: number | undefined;
  let anyTradeYet = false;

  /** 逐笔单边成本率：半价差 + √冲击，财报窗口放大；无 ADV → flatBps */
  const costRateOf = (t: string, date: string, notional: number, inEarningsWindow: boolean): number => {
    const adv = advAt.get(t)?.(date);
    let bps = adv !== undefined && adv > 0 ? cfg.cost.halfSpreadBps + cfg.cost.impactCoef * Math.sqrt(notional / adv) * 10_000 : cfg.cost.flatBps;
    if (inEarningsWindow) bps *= cfg.cost.earningsMult;
    return bps / 10_000;
  };

  const priceOf = (t: string, d: string): number | undefined => {
    const px = lookup.get(t)?.(d);
    return px !== undefined && px > 0 ? px : undefined;
  };

  const equityOf = (d: string, u: Map<string, number>, cashAmount: number): number => {
    let v = cashAmount;
    for (const t of cfg.tickers) v += (u.get(t) ?? 0) * (priceOf(t, d) ?? 0);
    return v;
  };

  /** 财报窗口判断：日期落在某财报日前 N ~ 后 M 天内 */
  const inEarningsWindow = (t: string, date: string): boolean => {
    if (!cfg.engines.earnings) return false;
    const dates = cfg.earningsByTicker.get(t);
    if (!dates?.length) return false;
    const now = Date.parse(date);
    for (const d of dates) {
      const diff = Math.round((Date.parse(d) - now) / 86_400_000);
      if (diff >= -cfg.earnings.daysAfter && diff <= cfg.earnings.daysBefore) return true;
    }
    return false;
  };

  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i];
    const regimePoint = regimeTimeline[i];
    if (date === undefined || regimePoint === undefined) continue;
    const friday = isFriday(date);

    // ---- 现金计息（三腿同待遇；无利率数据则跳过）----
    const annualRate = cashRateAt?.(date);
    if (annualRate !== undefined && annualRate > 0) {
      const daily = annualRate / 100 / 365;
      if (cash > 0) cash *= 1 + daily;
      if (benchCash > 0) benchCash *= 1 + daily;
      if (b40Cash > 0) b40Cash *= 1 + daily;
    }

    const month = date.slice(0, 7);
    const newMonth = month !== lastMonth;
    lastMonth = month;

    // ---- 基准腿 ①：与策略腿完全相同的现金流（首日等权建仓 + 每周五等权加买），同成本模型 ----
    if (!benchSeeded) {
      const pxs = cfg.tickers.map((t) => priceOf(t, date));
      if (pxs.every((px) => px !== undefined)) {
        const rates = cfg.tickers.map((t) => costRateOf(t, date, benchCash / cfg.tickers.length, false));
        const denom = cfg.tickers.reduce((a, _t, k) => a + 1 + (rates[k] as number), 0);
        const per = benchCash / denom; // 计费后现金恰好归零，不透支
        cfg.tickers.forEach((t, k) => benchUnits.set(t, per / (pxs[k] as number)));
        benchCash = 0;
        benchSeeded = true;
      }
    } else if (friday && cfg.engines.dca && cfg.dcaUsdt > 0) {
      benchCash += cfg.dcaUsdt;
      const rates = cfg.tickers.map((t) => costRateOf(t, date, benchCash / cfg.tickers.length, false));
      const denom = cfg.tickers.reduce((a, _t, k) => a + 1 + (rates[k] as number), 0);
      const per = benchCash / denom;
      for (const [k, t] of cfg.tickers.entries()) {
        const px = priceOf(t, date);
        if (px) benchUnits.set(t, (benchUnits.get(t) ?? 0) + per / px);
      }
      benchCash = 0;
    }

    // ---- 基准腿 ②：60/40，每月初把股票腿拉回 60%，同成本模型 ----
    if (!b40Seeded) {
      const pxs = cfg.tickers.map((t) => priceOf(t, date));
      if (pxs.every((px) => px !== undefined)) {
        b40Cash = cfg.startCash;
        const targetStock = b40Cash * 0.6;
        const per = targetStock / cfg.tickers.length;
        cfg.tickers.forEach((t, k) => b40Units.set(t, per / (pxs[k] as number)));
        b40Cash -= targetStock;
        b40Seeded = true;
      }
    } else if (newMonth) {
      const eq = equityOf(date, b40Units, b40Cash);
      const targetStock = eq * 0.6;
      for (const [k, t] of cfg.tickers.entries()) {
        const px = priceOf(t, date);
        if (!px) continue;
        const delta = targetStock / cfg.tickers.length - (b40Units.get(t) ?? 0) * px;
        if (Math.abs(delta) < cfg.minTradeUsdt) continue;
        const rate = costRateOf(t, date, Math.abs(delta), false);
        b40Units.set(t, (b40Units.get(t) ?? 0) + delta / px);
        b40Cash -= delta * (1 + (delta > 0 ? rate : -rate));
      }
    }

    // ---- 策略腿目标仓位：体制档位 × 波动率乘数 × (1 + 估值偏移) × (1 + 情绪偏移) ----
    const regimeTarget = cfg.engines.regime ? regimePoint.equityTarget : 1;
    const volMult = cfg.engines.volTarget ? cfg.volMult?.[i] : undefined;
    const tilt = cfg.engines.valuation ? cfg.tilt?.[i] : undefined;
    const sentTilt = cfg.engines.sentiment ? cfg.sentTilt?.[i] : undefined;
    const equityTarget = composeEquityTarget(regimeTarget, volMult, tilt, sentTilt);
    targetSeries.push({ date, value: equityTarget });

    if (friday && cfg.engines.dca) cash += cfg.dcaUsdt;
    const equity = equityOf(date, units, cash);
    const perTickerTarget = equityTarget / cfg.tickers.length;

    // ---- 触发判断 ----
    const batchDrivers: TradeDriver[] = [];
    if (!anyTradeYet) batchDrivers.push("seed");
    if (friday && cfg.engines.dca && cfg.dcaUsdt > 0) batchDrivers.push("dca");
    if (cfg.engines.regime && prevRegime !== null && (regimePoint.regime !== prevRegime || regimePoint.gateActive !== prevGate))
      batchDrivers.push("regime");
    if (
      cfg.engines.volTarget &&
      volMult !== undefined &&
      volMultAtRebalance !== undefined &&
      Math.abs(volMult - volMultAtRebalance) * 100 > cfg.volTriggerPp
    )
      batchDrivers.push("volTarget");
    if (
      cfg.engines.valuation &&
      tilt !== undefined &&
      tiltAtRebalance !== undefined &&
      Math.abs(tilt - tiltAtRebalance) * 100 > cfg.valueTriggerPp
    )
      batchDrivers.push("valuation");
    if (
      cfg.engines.sentiment &&
      sentTilt !== undefined &&
      sentTiltAtRebalance !== undefined &&
      Math.abs(sentTilt - sentTiltAtRebalance) * 100 > cfg.sentTriggerPp
    )
      batchDrivers.push("sentiment");
    if (
      cfg.engines.drift &&
      equity > 0 &&
      cfg.tickers.some((t) => {
        const px = priceOf(t, date);
        const tgt = perTickerTarget * (inEarningsWindow(t, date) ? cfg.earnings.scale : 1);
        return px ? Math.abs(((units.get(t) ?? 0) * px) / equity - tgt) * 100 > cfg.driftThresholdPp : false;
      })
    )
      batchDrivers.push("drift");

    if (batchDrivers.length && equity > 0) {
      const targetStockValue = equity * equityTarget;
      const plan = cfg.tickers
        .map((t) => {
          const px = priceOf(t, date);
          const scale = inEarningsWindow(t, date) ? cfg.earnings.scale : 1;
          const delta = px ? (targetStockValue * scale) / cfg.tickers.length / px - (units.get(t) ?? 0) : 0;
          return { t, px: px as number | undefined, delta, notional: px ? Math.abs(delta) * px : 0 };
        })
        .filter((p) => p.px && p.notional >= cfg.minTradeUsdt);

      const driversFor = (t: string): TradeDriver[] => [
        ...batchDrivers,
        ...(inEarningsWindow(t, date) && !batchDrivers.includes("earnings") ? (["earnings"] as TradeDriver[]) : []),
      ];

      const fill = (p: (typeof plan)[number], buying: boolean) => {
        const px = p.px as number;
        if (buying) {
          const probe = Math.min(p.notional, cash);
          const rate = costRateOf(p.t, date, probe, inEarningsWindow(p.t, date));
          const notional = Math.min(probe, cash / (1 + rate));
          if (notional * (1 + rate) < cfg.minTradeUsdt) return;
          const cost = notional * rate;
          cash -= notional * (1 + rate);
          units.set(p.t, (units.get(p.t) ?? 0) + notional / px);
          totalCosts += cost;
          trades.push({ date, ticker: p.t, unitsDelta: notional / px, notionalUsdt: notional, costUsd: cost, drivers: driversFor(p.t) });
        } else {
          const rate = costRateOf(p.t, date, p.notional, inEarningsWindow(p.t, date));
          const cost = p.notional * rate;
          cash += p.notional * (1 - rate);
          units.set(p.t, (units.get(p.t) ?? 0) + p.delta);
          totalCosts += cost;
          trades.push({ date, ticker: p.t, unitsDelta: p.delta, notionalUsdt: p.notional, costUsd: cost, drivers: driversFor(p.t) });
        }
      };

      // 先卖后买：卖出释放的现金可立即用于买入，避免同日无谓的负余额
      for (const p of plan.filter((x) => x.delta < 0)) fill(p, false);
      for (const p of plan.filter((x) => x.delta > 0)) fill(p, true);
      if (plan.length) {
        anyTradeYet = true;
        volMultAtRebalance = volMult ?? volMultAtRebalance;
        tiltAtRebalance = tilt ?? tiltAtRebalance;
        sentTiltAtRebalance = sentTilt ?? sentTiltAtRebalance;
      }
    }

    prevRegime = regimePoint.regime;
    prevGate = regimePoint.gateActive;
    regimeDays[regimePoint.regime] = (regimeDays[regimePoint.regime] ?? 0) + 1;
    strategyEquity.push({ date, value: equityOf(date, units, cash) });
    benchmarkEquity.push({ date, value: equityOf(date, benchUnits, benchCash) });
    benchmark6040Equity.push({ date, value: equityOf(date, b40Units, b40Cash) });
  }

  const lastDate = calendar[calendar.length - 1] ?? "";
  const finalEquity = strategyEquity[strategyEquity.length - 1]?.value ?? 0;
  const finalWeights: Record<string, number> = {};
  for (const t of cfg.tickers) {
    const px = priceOf(t, lastDate);
    finalWeights[t] = finalEquity > 0 && px ? ((units.get(t) ?? 0) * px) / finalEquity : 0;
  }
  finalWeights["cash"] = finalEquity > 0 ? cash / finalEquity : 0;

  return {
    calendar,
    strategyEquity,
    benchmarkEquity,
    benchmark6040Equity,
    trades,
    regimeDays,
    finalWeights,
    costsPaid: totalCosts,
    targetSeries,
  };
}
