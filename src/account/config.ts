/**
 * 实盘账户层：config/account.json 的类型、装载与进度计算。
 * 与策略层刻意分离——策略回答"按什么权重买"，账户层回答"有多少钱、什么时候到、
 * 还能换多少汇"。两边在影子账本（deployment.ledgerMode）汇合。
 */
import { readFileSync } from "node:fs";

export interface AccountFile {
  account: { broker: string; status: string };
  capital: {
    totalPlannedCny: number;
    fxAssumptionCnyPerUsd: number;
    annualQuotaUsd: number;
  };
  deployment: {
    ledgerMode: string;
    batches: { label: string; targetDate: string; amountUsd: number }[];
  };
}

export function loadAccountFile(path = "config/account.json"): AccountFile {
  return JSON.parse(readFileSync(path, "utf8")) as AccountFile;
}

/** 台账行的最小结构（DB 的 AccountEvent 的结构子集，便于纯函数测试） */
export interface LedgerRow {
  occurredAt: string;
  kind: string;
  amount: number;
  currency: string;
  fxRate: number | null;
}

/** 单笔入金折算成 USD：USD 原样；CNY 按事件汇率，缺汇率退回假设汇率 */
export function depositToUsd(d: { amount: number; currency: string; fxRate: number | null }, fallbackCnyPerUsd: number): number {
  return d.currency === "USD" ? d.amount : d.amount / (d.fxRate ?? fallbackCnyPerUsd);
}

export interface AccountSummary {
  /** 分批建仓计划合计（美元） */
  plannedUsd: number;
  /** 总资金按假设汇率折算（美元） */
  totalUsdEquivalent: number;
  /** 计划外的缓冲（人民币口径）：额度与批次之外的剩余 */
  bufferCny: number;
  /** 入金折算成 USD 后按年累计——占购汇额度的口径 */
  depositsUsdByYear: Record<number, number>;
  depositCount: number;
}

/** 入金流水 → 额度占用与批次进度。纯函数：CLI 与未来的部署页共用同一口径 */
export function accountSummary(cfg: AccountFile, events: LedgerRow[]): AccountSummary {
  const plannedUsd = cfg.deployment.batches.reduce((s, b) => s + b.amountUsd, 0);
  const totalUsdEquivalent = cfg.capital.totalPlannedCny / cfg.capital.fxAssumptionCnyPerUsd;
  const depositsUsdByYear: Record<number, number> = {};
  let depositCount = 0;
  for (const e of events) {
    if (e.kind !== "deposit") continue;
    depositCount++;
    const year = Number(e.occurredAt.slice(0, 4));
    const usd = e.currency === "USD" ? e.amount : e.amount / (e.fxRate ?? cfg.capital.fxAssumptionCnyPerUsd);
    depositsUsdByYear[year] = (depositsUsdByYear[year] ?? 0) + usd;
  }
  return {
    plannedUsd,
    totalUsdEquivalent,
    // 缓冲 = 批次计划之外的剩余，与已入金进度无关（入的是计划内的钱）
    bufferCny: cfg.capital.totalPlannedCny - plannedUsd * cfg.capital.fxAssumptionCnyPerUsd,
    depositsUsdByYear,
    depositCount,
  };
}
