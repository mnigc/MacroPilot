/**
 * CSV → DB 导入：npm run import-csv
 *
 * sync-data workflow 在 python 同步后调用：data/prices/*.csv（date,open,high,low,close,volume）
 * 与 data/earnings/*.csv（date,value）入库。prices 表同时拿到 close 与 volume——
 * 回测、执行器、展示层统一从 DB 读，CSV 只是 Actions 的传输格式。
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getPool, initSchema, upsertPriceRows, upsertEarningsDates } from "../src/db/index.js";

await initSchema();
const db = getPool();

let priceRows = 0;
const priceDir = "data/prices";
if (existsSync(priceDir)) {
  for (const f of readdirSync(priceDir)) {
    if (!f.endsWith(".csv")) continue;
    const ticker = f.replace(".csv", "").toUpperCase();
    const lines = readFileSync(`${priceDir}/${f}`, "utf8").split(/\r?\n/);
    const head = (lines[0] ?? "").split(",").map((x) => x.trim().toLowerCase());
    const di = head.indexOf("date");
    const ci = head.indexOf("close") >= 0 ? head.indexOf("close") : head.indexOf("value");
    if (di < 0 || ci < 0) continue;
    const vi = head.indexOf("volume");
    const rows: { date: string; close: number; volume: number | null }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i]?.split(",");
      if (!c) continue;
      const date = c[di];
      const close = Number(c[ci]);
      if (!date || !Number.isFinite(close)) continue;
      const volRaw = vi >= 0 ? c[vi]?.trim() : undefined;
      const volume = volRaw !== undefined && volRaw !== "" ? Number(volRaw) : null;
      rows.push({ date, close, volume: volume !== null && Number.isFinite(volume) && volume > 0 ? volume : null });
    }
    priceRows += await upsertPriceRows(ticker, rows);
    console.log(`  ${ticker}: ${rows.length} 行（含成交量 ${rows.filter((r) => r.volume !== null).length}）`);
  }
}

let earnRows = 0;
const earnDir = "data/earnings";
if (existsSync(earnDir)) {
  for (const f of readdirSync(earnDir)) {
    if (!f.endsWith(".csv")) continue;
    const ticker = f.replace(".csv", "").toUpperCase();
    const lines = readFileSync(`${earnDir}/${f}`, "utf8").split(/\r?\n/);
    const dates: { ticker: string; date: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const date = lines[i]?.split(",")[0]?.trim();
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push({ ticker, date });
    }
    await upsertEarningsDates(dates);
    earnRows += dates.length;
  }
}

const { rows } = await db.query<{ v: number | null }>(
  "select count(*)::int as v from prices where volume is not null",
);
console.log(`CSV → DB 完成：价格 ${priceRows} 行 upsert，财报 ${earnRows} 行 upsert；表内带成交量的行共 ${rows[0]?.v ?? 0}`);
await db.end();
