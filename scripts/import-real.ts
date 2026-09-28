/**
 * 真实成交账本导入：npm run import-real -- data/real/trades.csv
 *
 * CSV 列：date,ticker,units_delta,price（units 带符号，正买负卖；price 为每股成交价）。
 * 真实成交价里已经含了滑点与手续费，所以不再计提成本；成本归因的真实口径是
 * "同一标的同一天 paper 假想成交价 vs 真实成交价"——这正是站点"真实 vs 纸面"对照的数据源。
 *
 * 导入语义：整分区重建（先清 mode='real' 的 trades/portfolio_state，再全量写入）——
 * 真实账本以券商对账单为准，CSV 就是事实源，改了就重导。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getPool, initSchema, savePortfolio } from "../src/db/index.js";

const path = process.argv[2];
if (!path) {
  console.error("用法: npm run import-real -- <csv 路径>（列: date,ticker,units_delta,price）");
  process.exit(1);
}

const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
const head = (lines[0] ?? "").split(",").map((x) => x.trim().toLowerCase());
const need = ["date", "ticker", "units_delta", "price"];
for (const col of need) {
  if (!head.includes(col)) {
    console.error(`CSV 缺少必需列 "${col}"（表头: ${head.join(",")}）`);
    process.exit(1);
  }
}

const rows = lines.slice(1).map((l) => {
  const c = l.split(",");
  const get = (name: string) => (c[head.indexOf(name)] as string).trim();
  return { date: get("date"), ticker: get("ticker").toUpperCase(), units: Number(get("units_delta")), price: Number(get("price")) };
});
const bad = rows.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.units) || r.units === 0 || !Number.isFinite(r.price) || r.price <= 0);
if (bad.length) {
  console.error(`以下 ${bad.length} 行不合法（日期格式/数量为 0/价格非正）:`, bad.slice(0, 5));
  process.exit(1);
}

await initSchema();
const db = getPool();
await db.query("begin");
try {
  await db.query("delete from trades where mode = 'real'");
  await db.query("delete from portfolio_state where mode = 'real'");
  const startCash = Number(process.env.REAL_START_CASH ?? 10_000);
  let cash = startCash;
  const positions = new Map<string, number>();
  for (const r of rows) {
    const notional = Math.abs(r.units) * r.price;
    cash -= r.units * r.price; // 买入减现金，卖出加现金；真实价已含成本
    positions.set(r.ticker, (positions.get(r.ticker) ?? 0) + r.units);
    await db.query(
      "insert into trades (mode, date, ticker, units_delta, notional_usdt, reason, cost_usdt) values ($1,$2,$3,$4,$5,'real',0)",
      ["real", r.date, r.ticker, r.units, notional],
    );
  }
  await db.query("commit");
  await savePortfolio("real", positions, cash);
  console.log(`真实账本已导入: ${rows.length} 笔 · 现金 $${cash.toFixed(2)} · 持仓 ${[...positions].map(([t, u]) => `${t} ${u.toFixed(4)}`).join(", ")}`);
} catch (e) {
  await db.query("rollback").catch(() => {});
  throw e;
} finally {
  await db.end();
}
