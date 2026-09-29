/**
 * 实盘账户台账 CLI：npm run account -- <status|record|seed>
 *
 *  - status                    账户总览：资金规划 / 购汇额度 / 批次进度 / 影子账本状态 / 最近流水
 *  - record <kind> [选项]       记一笔资金事件（deposit/withdraw/fx/fee/tax/other）
 *  - seed --cash N [--mode M]  给影子账本分区注入初始现金（首批入金到账后执行一次）
 *
 * 账户层记录的是"钱"：入金、换汇、费用、税。策略层（strategy.json / 执行器）只回答
 * "按什么权重买"，从不碰本金数字——两边在影子账本（deployment.ledgerMode）汇合。
 * 台账只增不删：记错了用一笔反向金额对冲（券商对账单才是最终事实源）。
 */
import "dotenv/config";
import {
  getPool,
  initSchema,
  loadAccountEvents,
  loadPortfolio,
  loadUndeployedDeposits,
  saveAccountEvent,
  savePortfolio,
} from "../src/db/index.js";
import { accountSummary, depositToUsd, loadAccountFile, type LedgerRow } from "../src/account/config.js";

const KINDS = ["deposit", "withdraw", "fx", "fee", "tax", "other"] as const;
const KIND_LABEL: Record<string, string> = {
  deposit: "入金",
  withdraw: "出金",
  fx: "换汇",
  fee: "费用",
  tax: "税",
  other: "其他",
};

const argv = process.argv.slice(2);
const cmd = argv[0];

function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
}

function usage(): never {
  console.error(
    [
      "用法:",
      "  npm run account -- status",
      "  npm run account -- record <deposit|withdraw|fx|fee|tax|other> --date YYYY-MM-DD --amount N --currency USD --rate 7.1 --note \"备注\"",
      "  npm run account -- seed --cash 10000 [--mode live-plan]",
    ].join("\n"),
  );
  process.exit(1);
}

if (!cmd) usage();

if (cmd === "record") {
  const kind = argv[1];
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    console.error(`kind 必须是 ${KINDS.join("/")}`);
    process.exit(1);
  }
  const date = argValue("--date");
  const amount = Number(argValue("--amount"));
  const currency = (argValue("--currency") ?? "USD").toUpperCase();
  const rateRaw = argValue("--rate");
  const fxRate = rateRaw !== undefined ? Number(rateRaw) : null;
  const note = argValue("--note");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("--date 必须是 YYYY-MM-DD");
    process.exit(1);
  }
  if (!Number.isFinite(amount) || amount === 0) {
    console.error("--amount 必须是非零数字（入金正、出金负）");
    process.exit(1);
  }
  if (!["USD", "CNY"].includes(currency)) {
    console.error("--currency 仅支持 USD / CNY");
    process.exit(1);
  }
  if (rateRaw !== undefined && (!Number.isFinite(fxRate) || (fxRate as number) <= 0)) {
    console.error("--rate 必须是正数（CNY/USD）");
    process.exit(1);
  }
  await initSchema();
  await saveAccountEvent({ occurredAt: date, kind, amount, currency, fxRate, note: note ?? null });
  console.log(
    `已记录 [${KIND_LABEL[kind]}] ${date} ${amount > 0 ? "+" : ""}${amount} ${currency}` +
      (fxRate ? `（汇率 ${fxRate}）` : "") +
      (note ? ` · ${note}` : ""),
  );
} else if (cmd === "seed") {
  const cfg = loadAccountFile();
  const mode = argValue("--mode") ?? cfg.deployment.ledgerMode;
  const cash = Number(argValue("--cash"));
  if (!Number.isFinite(cash) || cash <= 0) {
    console.error("--cash 必须是正数（首批入金的美元金额）");
    process.exit(1);
  }
  await initSchema();
  const existing = await loadPortfolio(mode);
  if (existing.cash !== 0 || existing.positions.size > 0) {
    console.error(
      `分区 "${mode}" 已有数据（现金 $${existing.cash.toFixed(2)}，持仓 ${existing.positions.size} 只）。` +
        `影子账本只应播种一次；如需重置先清理该分区的 portfolio_state / trades / runtime_state 行。`,
    );
    process.exit(1);
  }
  await savePortfolio(mode, new Map(), cash);
  console.log(`影子账本 "${mode}" 已播种：现金 $${cash.toFixed(2)}，持仓为空。之后 npm run agent -- --mode ${mode} 即可空跑执行器。`);
} else if (cmd === "status") {
  const cfg = loadAccountFile();
  await initSchema();
  const events = await loadAccountEvents();
  const summary = accountSummary(
    cfg,
    events as unknown as LedgerRow[],
  );
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const quotaUsed = summary.depositsUsdByYear[year] ?? 0;

  console.log(`券商: ${cfg.account.broker} · 状态: ${cfg.account.status}`);
  console.log(
    `资金规划: 总 ${cfg.capital.totalPlannedCny.toLocaleString()} CNY ≈ ${summary.totalUsdEquivalent.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD` +
      `（假设汇率 ${cfg.capital.fxAssumptionCnyPerUsd}）· 批次计划合计 $${summary.plannedUsd.toLocaleString()}`,
  );
  console.log(
    `购汇额度 ${year}: 已用 $${quotaUsed.toLocaleString("en-US", { maximumFractionDigits: 2 })} / $${cfg.capital.annualQuotaUsd.toLocaleString()}` +
      ` · 剩余 $${(cfg.capital.annualQuotaUsd - quotaUsed).toLocaleString("en-US", { maximumFractionDigits: 2 })}` +
      `（由入金流水按年自动汇总，共 ${summary.depositCount} 笔入金）`,
  );
  console.log(`缓冲（计划外人民币口径）: ${Math.round(summary.bufferCny).toLocaleString()} CNY`);

  console.log(`\n分批建仓计划（影子账本分区 "${cfg.deployment.ledgerMode}"）:`);
  let cumulative = 0;
  for (const b of cfg.deployment.batches) {
    cumulative += b.amountUsd;
    const status = b.targetDate <= today ? "已到期" : "待执行";
    console.log(`  ${b.label}  ${b.targetDate}  $${b.amountUsd.toLocaleString()}  累计 $${cumulative.toLocaleString()}  [${status}]`);
  }

  const ledger = await loadPortfolio(cfg.deployment.ledgerMode);
  if (ledger.cash === 0 && ledger.positions.size === 0) {
    console.log(`\n影子账本 "${cfg.deployment.ledgerMode}": 未播种（首批入金到账后 npm run account -- seed --cash <金额>）`);
  } else {
    console.log(
      `\n影子账本 "${cfg.deployment.ledgerMode}": 现金 $${ledger.cash.toFixed(2)} · 持仓 ${ledger.positions.size} 只` +
        `（${[...ledger.positions.keys()].join(", ") || "无"}）`,
    );
  }

  const pending = await loadUndeployedDeposits();
  if (pending.length) {
    const pendingUsd = pending.reduce((s, e) => s + depositToUsd(e, cfg.capital.fxAssumptionCnyPerUsd), 0);
    console.log(
      `待部署入金: $${pendingUsd.toFixed(2)}（${pending.length} 笔）—— 下一次 npm run agent -- --mode ${cfg.deployment.ledgerMode} 自动按目标权重部署`,
    );
  }

  if (events.length) {
    console.log(`\n最近流水（${events.length} 条，只增不删，错账用反向金额对冲）:`);
    for (const e of events.slice(0, 15)) {
      console.log(
        `  ${e.occurredAt}  [${KIND_LABEL[e.kind] ?? e.kind}] ${e.amount > 0 ? "+" : ""}${e.amount} ${e.currency}` +
          (e.fxRate ? ` @ ${e.fxRate}` : "") +
          (e.note ? ` · ${e.note}` : ""),
      );
    }
  } else {
    console.log("\n流水为空：入金/换汇后用 npm run account -- record 记账");
  }
} else {
  usage();
}

await getPool().end();
