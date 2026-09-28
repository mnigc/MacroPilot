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
import { runOnce, type ExecutorConfig } from "./exec/executor.js";
import { earningsCalendarStatus } from "./db/index.js";
import { regimeConfigOf, loadStrategyFile, volTargetConfigOf, valuationConfigOf } from "./backtest/context.js";
import { splitDrivers } from "./strategy/drivers.js";

const raw = loadStrategyFile();
const dryRun = process.argv.includes("--dry-run");

/**
 * 账本分区。默认 paper（公开账本）；config 里临时改成别的值即可空跑执行器。
 * CI 里必须为 paper——否则一次误提交的试跑分区会让公开仪表盘静默停更，所以直接失败而不是警告。
 */
const mode = raw.execution.mode ?? "paper";
if (process.env.CI && mode !== "paper") {
  throw new Error(`CI 环境下 execution.mode 必须为 paper，当前为 "${mode}"——请检查 config/strategy.json 是否误提交了试跑分区`);
}

const cfg: ExecutorConfig = {
  tickers: raw.basket.tickers,
  mode,
  dryRun,
  startCash: raw.execution.startCashUsdt ?? 10_000,
  dcaUsdt: raw.engines.dca.amountUsdt,
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
      .map((d) => ({ seed: "初始建仓", dca: "定投", regime: "体制", volTarget: "波动率", valuation: "估值", drift: "漂移", earnings: "财报" })[d])
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
