/**
 * 单次执行入口：npm run agent（加 --dry-run 只算不写）
 * 每次运行完成一轮完整决策：宏观信号 → 体制状态 → 叠加层（波动率/估值）→ 目标权重 → 纸面成交。
 *
 * 正常运行顺带：
 *  - 写 executor_preview（"下一轮会做什么"的预告，站点直接展示）
 *  - 体制切换/财报窗口等事件发生时推送 webhook（ALERT_WEBHOOK_URL 通用 JSON /
 *    DISCORD_WEBHOOK_URL Discord 格式，未配置则跳过）
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { runOnce, type ExecutorConfig } from "./exec/executor.js";
import { earningsCalendarStatus } from "./db/index.js";
import { regimeConfigOf, loadStrategyFile, volTargetConfigOf, valuationConfigOf } from "./backtest/context.js";
import { loadAccountFile } from "./account/config.js";
import { splitDrivers } from "./strategy/drivers.js";

const raw = loadStrategyFile();
const dryRun = process.argv.includes("--dry-run");

/**
 * 账本分区。默认 paper（公开账本）；config 的 execution.mode 或命令行 --mode 可临时指向
 * 别的分区空跑执行器（如真实本金规模的影子账本 live-plan）。
 * CI 里必须为 paper——否则一次误提交的试跑分区会让公开仪表盘静默停更，所以直接失败而不是警告。
 */
const modeFlagIdx = process.argv.indexOf("--mode");
const mode = modeFlagIdx > -1
  ? process.argv[modeFlagIdx + 1] ?? ""
  : raw.execution.mode ?? "paper";
if (modeFlagIdx > -1 && !mode) {
  throw new Error("--mode 需要一个分区名，例如: npm run agent -- --mode live-plan");
}
if (process.env.CI && mode !== "paper") {
  throw new Error(`CI 环境下 execution.mode 必须为 paper，当前为 "${mode}"——请检查 config/strategy.json 是否误提交了试跑分区`);
}

/**
 * 注入源：账本分区与 account.json 的 deployment.ledgerMode 一致时，切换为 deposits 模式——
 * 注入额来自台账未部署的新入金（npm run account -- record），批次到账后下一轮自动部署；
 * paper 与其他试跑分区保持每周五定投。
 */
let injectionMode: "weekly" | "deposits" = "weekly";
let depositFxFallback: number | undefined;
try {
  const acct = loadAccountFile();
  if (mode === acct.deployment.ledgerMode) {
    injectionMode = "deposits";
    depositFxFallback = acct.capital.fxAssumptionCnyPerUsd;
  }
} catch {
  /* account.json 不在时按 weekly 定投 */
}

/** 深度剔除 "$" 前缀键：$comment 是给人看的注释，进签名会让改注释也触发 retarget */
function stripMetaKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripMetaKeys) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (!k.startsWith("$")) out[k] = stripMetaKeys(val);
    return out as T;
  }
  return v;
}

const cfg: ExecutorConfig = {
  tickers: raw.basket.tickers,
  mode,
  dryRun,
  startCash: raw.execution.startCashUsdt ?? 10_000,
  dcaUsdt: raw.engines.dca.amountUsdt,
  injectionMode,
  depositFxFallback,
  driftThresholdPp: raw.engines.drift.thresholdPp,
  minTradeUsdt: raw.execution.minTradeUsdt,
  slippagePercent: raw.execution.slippagePercent,
  regime: regimeConfigOf(raw),
  earnings: {
    enabled: raw.engines.earnings.enabled ?? true,
    riskOffDaysBefore: raw.engines.earnings.riskOffDaysBefore,
    scaleFactor: raw.engines.earnings.scaleFactor,
    restoreDaysAfter: raw.engines.earnings.restoreDaysAfter,
  },
  volTarget: volTargetConfigOf(raw),
  valuation: valuationConfigOf(raw),
  cost: raw.execution.cost ?? { halfSpreadBps: 3, impactCoef: 0.35, earningsMult: 1.5 },
  cashInterest: raw.execution.cashInterest ?? true,
  // 配置签名：影响目标表的全部参数——变更即触发 retarget 对齐，不等漂移阈值。
  // $comment 注释键剔除后再哈希，否则纯文案修改也会造成一次无谓的强制调仓
  configSig: createHash("sha1")
    .update(
      JSON.stringify(stripMetaKeys({
        allocation: raw.engines.regime.allocation,
        gate: raw.engines.regime.gate ?? null,
        volTarget: raw.engines.volTarget ?? null,
        valuation: raw.engines.valuation ?? null,
        drift: raw.engines.drift,
        earnings: raw.engines.earnings,
        tickers: raw.basket.tickers,
      })),
    )
    .digest("hex")
    .slice(0, 12),
};

if (dryRun) console.log("—— dry-run：全流程照算，不落任何库 ——\n");
else if (mode !== "paper") {
  console.warn(
    `⚠ 账本分区 = "${mode}"（非 paper）：本轮成交写入该分区，公开账本不受影响。跑完清理：\n` +
      `   delete from trades where mode='${mode}'; delete from portfolio_state where mode='${mode}'; delete from runtime_state where mode='${mode}';`,
  );
}

const summary = await runOnce(cfg);

const { composition } = summary;
console.log(`\n决策数据日: ${summary.regime.date}`);
console.log(
  `体制: ${summary.regime.regime} · score=${summary.regime.score.toFixed(3)}` +
    (summary.regime.gateActive ? ` · ⚠ Sahm 门生效（${summary.regime.sahm?.toFixed(2)}pp ≥ 阈值，仓位压回防御档）` : ""),
);
console.log(
  `目标股票仓位: ${(summary.composedEquityTarget * 100).toFixed(1)}% = 体制 ${(composition.regimeTarget * 100).toFixed(0)}%` +
    ` × 波动率 ${composition.volMult !== undefined ? composition.volMult.toFixed(2) : "—"} × (1 + 估值 ${composition.tilt !== undefined ? (composition.tilt * 100).toFixed(1) + "%" : "—"})`,
);
if (summary.cashInterestUsd > 0) console.log(`现金计息: +$${summary.cashInterestUsd.toFixed(2)}（DGS3MO，按距上一轮天数）`);
if (summary.injectionUsd > 0) {
  console.log(
    `本轮注入: $${summary.injectionUsd.toFixed(2)}` +
      (cfg.injectionMode === "deposits" ? "（部署台账新入金）" : "（周五定投）"),
  );
}
if (cfg.earnings.enabled) {
  const status = await earningsCalendarStatus(cfg.tickers);
  console.log(`财报日历: ${status.rows} 行（未来 ${status.upcoming} 场）`);
}
if (summary.earningsAffected.length) console.log(`⚠ 财报引擎生效: ${summary.earningsAffected.join(", ")} 临近财报，权重已缩放`);
console.log(`组合净值: $${summary.equityBefore.toFixed(2)} → $${summary.equityAfter.toFixed(2)}`);
console.log(`目标权重: ${Object.entries(summary.targetWeights).map(([t, w]) => `${t}=${(w * 100).toFixed(1)}%`).join(" ")}`);

if (summary.trades.length === 0) {
  console.log("本轮无需调仓（漂移在阈值内，且非定投日）");
} else {
  console.log(`成交 ${summary.trades.length} 笔（逐笔标注全部触发引擎）:`);
  let costs = 0;
  for (const t of summary.trades) {
    const drivers = splitDrivers(t.drivers.join(","))
      .map((d) => ({ seed: "初始建仓", dca: "定投", regime: "体制", volTarget: "波动率", valuation: "估值", retarget: "调参", drift: "漂移", earnings: "财报" })[d])
      .join("+");
    costs += t.costUsd;
    console.log(
      `  [${drivers}] ${t.ticker} ${t.unitsDelta >= 0 ? "买入" : "卖出"} ${Math.abs(t.unitsDelta).toFixed(6)} 股，$${t.notionalUsdt.toFixed(2)}（成本 $${t.costUsd.toFixed(2)}）`,
    );
  }
  console.log(`本轮交易成本合计: $${costs.toFixed(2)}`);
}

// 下一轮预告摘要
const preview = summary.preview as {
  nextFriday: { date: string; injectionUsdt: number; planned: { ticker: string; usdt: number }[] } | null;
  drifts: { ticker: string; driftPp: number; thresholdPp: number }[];
  earningsNext14d: { ticker: string; date: string }[];
};
if (preview.nextFriday) {
  console.log(
    `下一轮定投 ${preview.nextFriday.date}: $${preview.nextFriday.injectionUsdt} → ${preview.nextFriday.planned.map((p) => `${p.ticker} $${p.usdt}`).join(" · ")}`,
  );
}
const nearDrift = preview.drifts.filter((d) => Math.abs(d.driftPp) > d.thresholdPp * 0.6).sort((a, b) => Math.abs(b.driftPp) - Math.abs(a.driftPp));
if (nearDrift.length) {
  console.log(`漂移预警（>60% 阈值）: ${nearDrift.map((d) => `${d.ticker} ${d.driftPp >= 0 ? "+" : ""}${d.driftPp}pp`).join(" · ")}`);
}
if (preview.earningsNext14d.length) {
  console.log(`未来 14 天财报: ${preview.earningsNext14d.map((e) => `${e.ticker} ${e.date}`).join(" · ")}`);
}
if (dryRun) console.log("\n—— dry-run 结束：数据库未动 ——");

// ---- 事件推送：财报窗口生效或发生成交时通知（未配置 webhook 则跳过）----
if (!dryRun && (summary.earningsAffected.length > 0 || summary.trades.length > 0)) {
  await notify(summary);
}

async function notify(s: Awaited<ReturnType<typeof runOnce>>): Promise<void> {
  const lines = [
    `MacroPilot ${s.asOf}`,
    `体制 ${s.regime.regime}（score ${s.regime.score.toFixed(3)}）· 目标仓位 ${(s.composedEquityTarget * 100).toFixed(0)}%`,
    s.earningsAffected.length ? `财报避险: ${s.earningsAffected.join(", ")}` : null,
    s.trades.length ? `成交 ${s.trades.length} 笔` : "本轮无调仓",
  ].filter(Boolean) as string[];
  const text = lines.join("\n");
  const generic = process.env.ALERT_WEBHOOK_URL;
  const discord = process.env.DISCORD_WEBHOOK_URL;
  try {
    if (generic) {
      await fetch(generic, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, asOf: s.asOf, regime: s.regime.regime, trades: s.trades.length }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (discord) {
      await fetch(discord, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch (e) {
    console.warn(`⚠ webhook 推送失败（不影响执行结果）: ${(e as Error).message}`);
  }
}
