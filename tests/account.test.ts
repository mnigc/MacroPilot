import { describe, expect, it } from "vitest";
import { accountSummary, depositToUsd, type AccountFile, type LedgerRow } from "../src/account/config.js";

const cfg: AccountFile = {
  account: { broker: "IBKR", status: "opening" },
  capital: { totalPlannedCny: 500_000, fxAssumptionCnyPerUsd: 7.1, annualQuotaUsd: 50_000 },
  deployment: {
    ledgerMode: "live-plan",
    batches: [
      { label: "第1批", targetDate: "2026-12-04", amountUsd: 10_000 },
      { label: "第2批", targetDate: "2027-01-08", amountUsd: 10_000 },
      { label: "第3批", targetDate: "2027-02-05", amountUsd: 10_000 },
      { label: "第4批", targetDate: "2027-03-05", amountUsd: 10_000 },
      { label: "第5批", targetDate: "2027-04-02", amountUsd: 10_000 },
    ],
  },
};

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  occurredAt: "2026-12-01",
  kind: "deposit",
  amount: 10_000,
  currency: "USD",
  fxRate: null,
  ...over,
});

/** 购汇额度占用：入金流水按年折算成 USD 汇总——CNY 入金按事件汇率折算 */
describe("账户层进度计算", () => {
  it("无流水时：计划合计与总资金折算正确，缓冲 = 总资金 − 计划", () => {
    const s = accountSummary(cfg, []);
    expect(s.plannedUsd).toBe(50_000);
    expect(s.totalUsdEquivalent).toBeCloseTo(500_000 / 7.1, 6);
    expect(s.depositCount).toBe(0);
    // 计划 5 万美元 ≈ 35.5 万 CNY，缓冲 = 50 万 − 35.5 万
    expect(s.bufferCny).toBeCloseTo(500_000 - 50_000 * 7.1, 6);
  });

  it("USD 入金按年归集，跨年批次各占当年额度", () => {
    const s = accountSummary(cfg, [
      row({ occurredAt: "2026-12-01" }),
      row({ occurredAt: "2027-01-05", amount: 20_000 }),
    ]);
    expect(s.depositsUsdByYear[2026]).toBe(10_000);
    expect(s.depositsUsdByYear[2027]).toBe(20_000);
    expect(s.depositCount).toBe(2);
    // 缓冲与入金进度无关：入的是计划内的钱，缓冲始终 = 总资金 − 计划批次合计
    expect(s.bufferCny).toBeCloseTo(500_000 - 50_000 * 7.1, 6);
  });

  it("CNY 入金按事件汇率折算成 USD；缺汇率时退回假设汇率", () => {
    const withRate = accountSummary(cfg, [row({ currency: "CNY", amount: 71_000, fxRate: 7.1 })]);
    expect(withRate.depositsUsdByYear[2026]).toBeCloseTo(10_000, 6);

    const fallback = accountSummary(cfg, [row({ currency: "CNY", amount: 71_000, fxRate: null })]);
    expect(fallback.depositsUsdByYear[2026]).toBeCloseTo(10_000, 6);
  });

  it("非 deposit 事件不占额度；出金（负入金）从额度占用中抵减", () => {
    const s = accountSummary(cfg, [
      row({}),
      row({ kind: "fee", amount: 25 }),
      row({ occurredAt: "2026-12-20", amount: -1_000 }),
    ]);
    expect(s.depositCount).toBe(2);
    expect(s.depositsUsdByYear[2026]).toBe(9_000);
  });
});

/** 影子账本注入源的折算口径：executor 的 deposits 注入模式与 CLI/页面共用 */
describe("depositToUsd", () => {
  it("USD 原样；CNY 按事件汇率；缺汇率退回假设汇率", () => {
    expect(depositToUsd({ amount: 10_000, currency: "USD", fxRate: null }, 7.1)).toBe(10_000);
    expect(depositToUsd({ amount: 71_000, currency: "CNY", fxRate: 7.28 }, 7.1)).toBeCloseTo(71_000 / 7.28, 6);
    expect(depositToUsd({ amount: 71_000, currency: "CNY", fxRate: null }, 7.1)).toBeCloseTo(10_000, 6);
  });
});
