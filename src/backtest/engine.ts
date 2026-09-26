import type { RegimePoint } from "../strategy/regime.js";
import type { TradeDriver } from "../strategy/drivers.js";

/**
 * 组合回测：与实盘执行器共用同一套目标权重合成逻辑。
 *
 * 策略腿：现金 + 篮子持仓。周五注入 DCA 现金；当（a）体制切换 或
 * (b) 任一资产权重偏离目标超过 driftThreshold 或（c)周五有现金待部署 时，
 * 一次性调到目标权重。双边按 costBps 计交易成本，小于最小单额的调仓跳过。
 *
 * 基准腿：同样的现金流（初始资金 + 每周 DCA），第一天等权买入后永不调仓——
 * 策略的超额必须来自择时与再平衡，而不是现金流差异。基准腿**同样按 costBps 计费**，
 * 否则策略被单边成本拖累、比较不公平。
 */

export interface BacktestConfig {
  tickers: string[];
  startCash: number;
  dcaUsdt: number; // 每周五注入；0 = 关闭定投
  driftThresholdPp: number;
  minTradeUsdt: number;
  /** 单边交易成本（基点），RFQ 价差 + gas 的保守估计 */
  costBps: number;
}

export interface Trade {
  date: string;
  ticker: string;
  unitsDelta: number;
  notionalUsdt: number;
  /** 触发本笔调仓的全部引擎（周五恰逢体制切换时两者皆记） */
  drivers: TradeDriver[];
}

export interface BacktestResult {
  calendar: string[];
  strategyEquity: { date: string; value: number }[];
  benchmarkEquity: { date: string; value: number }[];
  trades: Trade[];
  regimeDays: Record<string, number>;
  finalWeights: Record<string, number>;
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

  let cash = cfg.startCash;
  const units = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));
  const trades: Trade[] = [];
  const strategyEquity: { date: string; value: number }[] = [];
  const benchmarkEquity: { date: string; value: number }[] = [];
  const regimeDays: Record<string, number> = {};
  let prevRegime: string | null = null;
  const feeRate = cfg.costBps / 10_000;

  // 基准腿：首日等权建仓，之后每周 DCA 等权加买，永不调仓
  const benchUnits = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));
  let benchCash = cfg.startCash;

  /** 用现金买入 targetNotional 的资产：手续费从同一笔现金出，故买入额受可用现金硬约束 */
  const clampBuyNotional = (targetNotional: number, availCash: number): number =>
    Math.min(targetNotional, availCash / (1 + feeRate));

  const priceOf = (t: string, d: string): number | undefined => {
    const px = lookup.get(t)?.(d);
    return px !== undefined && px > 0 ? px : undefined;
  };

  const equityOf = (d: string, u: Map<string, number>, cashAmount: number): number => {
    let v = cashAmount;
    for (const t of cfg.tickers) v += (u.get(t) ?? 0) * (priceOf(t, d) ?? 0);
    return v;
  };

  let benchSeeded = false;

  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i];
    const regimePoint = regimeTimeline[i];
    if (date === undefined || regimePoint === undefined) continue;
    const friday = isFriday(date);

    // 基准腿：与策略腿完全相同的现金流（首日等权建仓 + 之后每周五等权加买），且同样计费——
    // 否则两腿的成本待遇不一致，比较不公平
    if (!benchSeeded) {
      const pxs = cfg.tickers.map((t) => priceOf(t, date));
      if (pxs.every((px) => px !== undefined)) {
        const affordable = clampBuyNotional(cfg.startCash, benchCash);
        const per = affordable / cfg.tickers.length;
        cfg.tickers.forEach((t, k) => benchUnits.set(t, per / (pxs[k] as number)));
        benchCash -= affordable * (1 + feeRate);
        benchSeeded = true;
      }
    } else if (friday && cfg.dcaUsdt > 0) {
      benchCash += cfg.dcaUsdt;
      const affordable = clampBuyNotional(cfg.dcaUsdt, benchCash);
      const per = affordable / cfg.tickers.length;
      for (const t of cfg.tickers) {
        const px = priceOf(t, date);
        if (px) benchUnits.set(t, (benchUnits.get(t) ?? 0) + per / px);
      }
      benchCash -= affordable * (1 + feeRate);
    }

    // 策略腿
    if (friday) cash += cfg.dcaUsdt;
    const equity = equityOf(date, units, cash);
    const targetStockPct = regimePoint.equityTarget;
    const perTickerTarget = targetStockPct / cfg.tickers.length;

    // 触发判断：周五有现金待部署 / 体制切换 / 任一标的漂移超阈值
    const batchDrivers: TradeDriver[] = [];
    if (friday && cfg.dcaUsdt > 0) batchDrivers.push("dca");
    if (prevRegime !== null && regimePoint.regime !== prevRegime) batchDrivers.push("regime");
    if (
      equity > 0 &&
      cfg.tickers.some((t) => {
        const px = priceOf(t, date);
        return px ? Math.abs(((units.get(t) ?? 0) * px) / equity - perTickerTarget) * 100 > cfg.driftThresholdPp : false;
      })
    )
      batchDrivers.push("drift");

    if (batchDrivers.length && equity > 0) {
      const targetStockValue = equity * targetStockPct;
      const plan = cfg.tickers
        .map((t) => {
          const px = priceOf(t, date);
          const delta = px ? targetStockValue / cfg.tickers.length / px - (units.get(t) ?? 0) : 0;
          return { t, px: px as number | undefined, delta, notional: px ? Math.abs(delta) * px : 0 };
        })
        .filter((p) => p.px && p.notional >= cfg.minTradeUsdt);

      // 先卖后买：卖出释放的现金可立即用于买入，避免同日无谓的负余额
      for (const p of plan.filter((x) => x.delta < 0)) {
        cash += p.notional * (1 - feeRate);
        units.set(p.t, (units.get(p.t) ?? 0) + p.delta);
        trades.push({ date, ticker: p.t, unitsDelta: p.delta, notionalUsdt: p.notional, drivers: batchDrivers });
      }
      for (const p of plan.filter((x) => x.delta > 0)) {
        const notional = clampBuyNotional(p.notional, cash);
        if (notional * (1 + feeRate) < cfg.minTradeUsdt) continue;
        const delta = notional / (p.px as number);
        cash -= notional * (1 + feeRate);
        units.set(p.t, (units.get(p.t) ?? 0) + delta);
        trades.push({ date, ticker: p.t, unitsDelta: delta, notionalUsdt: notional, drivers: batchDrivers });
      }
    }

    prevRegime = regimePoint.regime;
    regimeDays[regimePoint.regime] = (regimeDays[regimePoint.regime] ?? 0) + 1;
    strategyEquity.push({ date, value: equityOf(date, units, cash) });
    benchmarkEquity.push({ date, value: equityOf(date, benchUnits, benchCash) });
  }

  const lastDate = calendar[calendar.length - 1] ?? "";
  const finalEquity = strategyEquity[strategyEquity.length - 1]?.value ?? 0;
  const finalWeights: Record<string, number> = {};
  for (const t of cfg.tickers) {
    const px = priceOf(t, lastDate);
    finalWeights[t] = finalEquity > 0 && px ? ((units.get(t) ?? 0) * px) / finalEquity : 0;
  }
  finalWeights["cash"] = finalEquity > 0 ? cash / finalEquity : 0;

  return { calendar, strategyEquity, benchmarkEquity, trades, regimeDays, finalWeights };
}
