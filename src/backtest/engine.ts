import type { RegimePoint } from "../strategy/regime.js";

/**
 * 组合回测：与实盘执行器共用同一套目标权重合成逻辑。
 *
 * 策略腿：现金 + 篮子持仓。周五注入 DCA 现金；当（a）体制切换 或
 * (b) 任一资产权重偏离目标超过 driftThreshold 或（c)周五有现金待部署 时，
 * 一次性调到目标权重。双边按 costBps 计交易成本，小于最小单额的调仓跳过。
 *
 * 基准腿：同样的现金流（初始资金 + 每周 DCA），第一天等权买入后永不调仓——
 * 策略的超额必须来自择时与再平衡，而不是现金流差异。
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
  reason: "dca" | "regime" | "drift";
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

  // 基准腿：首日等权建仓，之后每周 DCA 等权加买，永不调仓
  const benchUnits = new Map<string, number>(cfg.tickers.map((t) => [t, 0]));

  const priceOf = (t: string, d: string): number | undefined => {
    const px = lookup.get(t)?.(d);
    return px !== undefined && px > 0 ? px : undefined;
  };

  const equityOf = (d: string, u: Map<string, number>, cashAmount: number): number => {
    let v = cashAmount;
    for (const t of cfg.tickers) v += (u.get(t) ?? 0) * (priceOf(t, d) ?? 0);
    return v;
  };

  let benchSeedDone = false;

  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i];
    const regimePoint = regimeTimeline[i];
    if (date === undefined || regimePoint === undefined) continue;
    const friday = isFriday(date);

    if (friday) {
      cash += cfg.dcaUsdt;
      // 基准腿同步定投
      const benchEquityBefore = equityOf(date, benchUnits, 0);
      if (benchSeedDone && benchEquityBefore > 0) {
        const per = cfg.dcaUsdt / cfg.tickers.length;
        for (const t of cfg.tickers) {
          const px = priceOf(t, date);
          if (px) benchUnits.set(t, (benchUnits.get(t) ?? 0) + per / px);
        }
      }
    }

    // 基准腿首日建仓
    if (!benchSeedDone) {
      const pxs = cfg.tickers.map((t) => priceOf(t, date));
      const ok = pxs.every((px) => px !== undefined);
      if (ok) {
        const total = cfg.startCash;
        const per = total / cfg.tickers.length;
        cfg.tickers.forEach((t, k) => {
          benchUnits.set(t, per / (pxs[k] as number));
        });
        benchSeedDone = true;
      }
    }

    // 策略腿：判断是否需要调仓
    const equity = equityOf(date, units, cash);
    const regimeChanged = prevRegime !== null && regimePoint.regime !== prevRegime;
    let reason: Trade["reason"] | null = friday ? "dca" : null;
    if (regimeChanged) reason = "regime";

    const targetStockPct = regimePoint.equityTarget;
    const perTickerTarget = targetStockPct / cfg.tickers.length;
    if (!reason) {
      for (const t of cfg.tickers) {
        const px = priceOf(t, date);
        if (!px || equity <= 0) continue;
        const w = ((units.get(t) ?? 0) * px) / equity;
        if (Math.abs(w - perTickerTarget) * 100 > cfg.driftThresholdPp) {
          reason = "drift";
          break;
        }
      }
    }

    if (reason && equity > 0) {
      const targetStockValue = equity * targetStockPct;
      for (const t of cfg.tickers) {
        const px = priceOf(t, date);
        if (!px) continue;
        const currentUnits = units.get(t) ?? 0;
        const targetUnits = targetStockValue / cfg.tickers.length / px;
        const delta = targetUnits - currentUnits;
        const notional = Math.abs(delta) * px;
        if (notional < cfg.minTradeUsdt) continue;
        cash -= delta * px; // 买入 delta>0 支出，卖出 delta<0 收入
        cash -= (notional * cfg.costBps) / 10_000;
        units.set(t, currentUnits + delta);
        trades.push({ date, ticker: t, unitsDelta: delta, notionalUsdt: notional, reason });
      }
    }

    prevRegime = regimePoint.regime;
    regimeDays[regimePoint.regime] = (regimeDays[regimePoint.regime] ?? 0) + 1;
    strategyEquity.push({ date, value: equityOf(date, units, cash) });
    benchmarkEquity.push({ date, value: equityOf(date, benchUnits, 0) });
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
