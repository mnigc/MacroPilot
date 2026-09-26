import { readFileSync, existsSync } from "node:fs";

export interface Series {
  dates: string[];
  closes: number[];
  /** [open, close, low, high]；历史 CSV 只有收盘价时为 null */
  ohlc: [number, number, number, number][] | null;
}

/**
 * 股价历史读自 `data/prices/{TICKER}.csv`（Actions 每日同步并 commit），而不是 Postgres：
 * prices 表只存 close，且回测把 DB 当缓存、只在表空时才回灌 CSV，OHLC 永远进不去。
 * 展示层直接吃 CSV，省掉一次全表迁移。
 */
const cache = new Map<string, Series>();

export function readSeries(ticker: string, from: string): Series {
  const key = `${ticker}:${from}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const path = `../data/prices/${ticker}.csv`;
  if (!existsSync(path)) throw new Error(`缺少价格文件：${path}（先跑 scripts/sync-prices.py 或等 CI 同步）`);

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const head = (lines[0] ?? "").split(",").map((s) => s.trim().toLowerCase());
  const cols = { date: head.indexOf("date"), open: head.indexOf("open"), high: head.indexOf("high"), low: head.indexOf("low"), close: head.indexOf("close") };
  const closeCol = cols.close >= 0 ? cols.close : head.indexOf("value");
  const hasOhlc = cols.open >= 0 && cols.high >= 0 && cols.low >= 0;

  const dates: string[] = [];
  const closes: number[] = [];
  const ohlc: [number, number, number, number][] | null = hasOhlc ? [] : null;

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const d = c[cols.date] ?? "";
    if (d < from) continue;
    const close = Number(c[closeCol]);
    if (!d || !Number.isFinite(close)) continue;
    dates.push(d);
    closes.push(close);
    if (ohlc) {
      const o = Number(c[cols.open]);
      const h = Number(c[cols.high]);
      const l = Number(c[cols.low]);
      ohlc.push([Number.isFinite(o) ? o : close, close, Number.isFinite(l) ? l : close, Number.isFinite(h) ? h : close]);
    }
  }
  const s = { dates, closes, ohlc };
  cache.set(key, s);
  return s;
}
