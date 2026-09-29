/**
 * 实盘部署页的账户层装配：config/account.json + account_events 台账 + 账本净值重放。
 * 额度/批次汇总口径与 scripts/account.ts（及 src/account/config.ts 的 accountSummary）
 * 是"同源数据两处算"——web 与 src 之间没有共享模块（engineState 同一先例），
 * 改口径必须两处同步；src 侧由 tests/account.test.ts 锁定。
 */
import { readFileSync } from "node:fs";
import {
  getAccountEvents,
  getClosesSince,
  getPortfolio,
  getTickerBoard,
  getTrades,
  getUndeployedDeposits,
  type ChartPoint,
  type PendingDepositRow,
  type TradeRow,
} from "./db";

export interface AccountCfg {
  account: { broker: string; status: string };
  capital: { totalPlannedCny: number; fxAssumptionCnyPerUsd: number; annualQuotaUsd: number };
  deployment: { ledgerMode: string; batches: { label: string; targetDate: string; amountUsd: number }[] };
}

export const KIND_LABEL: Record<string, string> = {
  deposit: "入金",
  withdraw: "出金",
  fx: "换汇",
  fee: "费用",
  tax: "税",
  other: "其他",
};

export const STATUS_LABEL: Record<string, string> = {
  opening: "开户中",
  funded: "已入金",
  live: "跟单中",
};

/** 入金折算 USD：与 src/account/config.ts 的 depositToUsd 同口径（web 与 src 无共享模块，改须两处同步） */
function depositUsd(d: { amount: number; currency: string; fxRate: number | null }, fallbackCnyPerUsd: number): number {
  return d.currency === "USD" ? d.amount : d.amount / (d.fxRate ?? fallbackCnyPerUsd);
}

/** 待部署新入金合计（美元）与笔数——影子账本执行器下一轮的注入源 */
export async function getPendingDeposits(fallbackCnyPerUsd: number): Promise<{ rows: PendingDepositRow[]; usd: number }> {
  const rows = await getUndeployedDeposits();
  return { rows, usd: rows.reduce((s, e) => s + depositUsd(e, fallbackCnyPerUsd), 0) };
}

export interface BatchRow {
  label: string;
  targetDate: string;
  amountUsd: number;
  cumulative: number;
  /** 目标日期已过（视为"应已完成"——是否真完成由入金流水佐证，不自动打勾） */
  due: boolean;
}

export interface AccountLayer {
  cfg: AccountCfg;
  events: Awaited<ReturnType<typeof getAccountEvents>>;
  /** 入金折算成 USD 后按年累计——占购汇额度的口径 */
  depositsUsdByYear: Record<number, number>;
  depositCount: number;
  plannedUsd: number;
  bufferCny: number;
  batches: BatchRow[];
  nextBatch: BatchRow | null;
  doneBatches: number;
}

export async function getAccountLayer(): Promise<AccountLayer> {
  const cfg = JSON.parse(readFileSync("../config/account.json", "utf8")) as AccountCfg;
  const events = await getAccountEvents();
  const today = new Date().toISOString().slice(0, 10);

  const depositsUsdByYear: Record<number, number> = {};
  let depositCount = 0;
  for (const e of events) {
    if (e.kind !== "deposit") continue;
    depositCount++;
    const y = Number(e.occurredAt.slice(0, 4));
    const usd = e.currency === "USD" ? e.amount : e.amount / (e.fxRate ?? cfg.capital.fxAssumptionCnyPerUsd);
    depositsUsdByYear[y] = (depositsUsdByYear[y] ?? 0) + usd;
  }

  const plannedUsd = cfg.deployment.batches.reduce((s, b) => s + b.amountUsd, 0);
  let cum = 0;
  const batches: BatchRow[] = cfg.deployment.batches.map((b) => ({
    ...b,
    cumulative: (cum += b.amountUsd),
    due: b.targetDate <= today,
  }));

  return {
    cfg,
    events,
    depositsUsdByYear,
    depositCount,
    plannedUsd,
    bufferCny: cfg.capital.totalPlannedCny - plannedUsd * cfg.capital.fxAssumptionCnyPerUsd,
    batches,
    nextBatch: batches.find((b) => !b.due) ?? null,
    doneBatches: batches.filter((b) => b.due).length,
  };
}

export interface LedgerView {
  mode: string;
  cash: number;
  positions: { ticker: string; units: number; close: number | null; value: number }[];
  /** 持仓中拿不到最新行情的标的（按 0 计会低估净值，必须显式标出） */
  missingPx: string[];
  equity: number;
  fills: number;
  firstDate: string | null;
  /** 按成交日重放的净值曲线；无成交时为空 */
  curve: ChartPoint[];
}

/**
 * 账本视图：当前快照（现金 + 持仓 × 最新收盘）+ 历史净值曲线。
 * 曲线以当前现金为锚向历史回推成交现金流，现金语义与执行器一致
 * （买入扣 notional×(1+rate)、卖出收 notional×(1−rate)，即 units×px + cost）。
 * 现金计息不重放：误差只落在历史段的闲置现金收益上（真实账本手动操作无计息，完全精确）。
 * 任一账本（real / live-plan / paper）无持仓也无成交时返回 null。
 */
export async function ledgerView(mode: string): Promise<LedgerView | null> {
  const [tradesDesc, portfolio] = await Promise.all([getTrades(mode), getPortfolio(mode)]);
  const posRows = portfolio.filter((p) => p.ticker !== "CASH");
  if (!tradesDesc.length && !posRows.length) return null;
  const trades = [...tradesDesc].reverse(); // 时间升序
  const tickers = [...new Set([...posRows.map((p) => p.ticker), ...trades.map((t) => t.ticker)])];
  const firstDate = trades[0]?.date ?? null;
  const [board, closes] = await Promise.all([
    getTickerBoard(tickers),
    firstDate ? getClosesSince(tickers, firstDate) : Promise.resolve(new Map()),
  ]);

  const latestPx = new Map(board.map((b) => [b.ticker, b.close]));
  const positions = posRows.map((p) => {
    const close = latestPx.get(p.ticker) ?? null;
    return { ticker: p.ticker, units: p.units, close, value: close === null ? 0 : p.units * close };
  });
  const missingPx = positions.filter((p) => p.close === null).map((p) => p.ticker);
  const cash = portfolio.find((p) => p.ticker === "CASH")?.units ?? 0;
  const equity = cash + positions.reduce((a, p) => a + p.value, 0);

  const dates = [...new Set(trades.map((t) => t.date))].sort();
  const curve: ChartPoint[] = [];
  if (dates.length) {
    // 现金流（正=流出现金）：units×成交价 + 成本；成交价由名义额反推，与落库口径一致
    const flow = (t: TradeRow) => t.units_delta * (t.notional_usdt / Math.abs(t.units_delta)) + (t.costUsdt ?? 0);
    const cumFlowByDate = new Map<string, number>();
    let totalFlow = 0;
    for (const d of dates) {
      totalFlow += trades.filter((t) => t.date === d).reduce((a, t) => a + flow(t), 0);
      cumFlowByDate.set(d, totalFlow);
    }

    const pos = new Map<string, number>();
    const ptr = new Map<string, number>(); // 每只标的的收盘价 carry 指针
    const dateLists = new Map([...closes].map(([t, m]) => [t, [...m.keys()]])); // 查询已按日期排序
    let ti = 0;
    for (const d of dates) {
      while (ti < trades.length && trades[ti].date <= d) {
        const t = trades[ti];
        pos.set(t.ticker, (pos.get(t.ticker) ?? 0) + t.units_delta);
        ti++;
      }
      // cash(t) = 当前现金 − 该日之后仍会发生的现金流
      const cashAt = cash - (totalFlow - (cumFlowByDate.get(d) ?? 0));
      let v = cashAt;
      for (const [t, units] of pos) {
        const m = closes.get(t);
        const ds = dateLists.get(t);
        if (!m || !ds) continue;
        let i = ptr.get(t) ?? 0;
        while (i + 1 < ds.length && ds[i + 1] <= d) i++;
        ptr.set(t, i);
        const px = m.get(ds[i]);
        if (px !== undefined) v += units * px;
      }
      curve.push({ date: d, value: v });
    }
  }

  return { mode, cash, positions, missingPx, equity, fills: trades.length, firstDate, curve };
}
