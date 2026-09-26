/**
 * 采集链上蜡烛并写库（web/ 构建时读取，用来画溢价历史与最近的真实量价）。
 *   npm run candles            → config/strategy.json 的整个篮子
 *   npm run candles -- NVDA    → 只采这几只
 *   npm run candles -- --dry   → 只打印不入库
 *
 * 一次跑两个端点，因为两者各缺一半：
 *   rwa_candles ← 公共 wallet-direct K 线，1d 口径 300 根（约一年），**无成交量**；
 *   rwa_ticks   ← 签名 /dex/market/candles，1 分钟粒度最多 300 根（≈5~6 小时），**有成交量**，翻不出历史。
 *
 * 选币与 scripts/spread.ts 走同一条聚合器询价路：同一个 ticker 在 BSC 上有 ondo/bstock 两枚，
 * 选了没有盘口的那一枚，记录下来的"链上价格"就和今天的溢价读数不是同一个市场，
 * 历史上的溢价曲线会画成一条直线。
 *
 * 首次运行会把约一年的历史一次补齐（该端点按 interval 给 300 根），之后每天重跑覆盖当天。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { RwaApi, BSC_CHAIN_ID_STR } from "../src/binance/rwa.js";
import { AggregatorApi } from "../src/binance/aggregator.js";
import { resolveTokens } from "../src/binance/tokens.js";
import { fetchKlines, fetchTicks, premiumFromCandles, type CandleRow, type KlineInterval, type TickRow } from "../src/binance/candles.js";
import { initSchema, saveCandles, saveTicks, usClosesByTicker } from "../src/db/index.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY");
  process.exit(1);
}

const strategy = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[]; quoteAsset: { address: string } };
};
const interval = (process.env.CANDLE_INTERVAL ?? "1d") as KlineInterval;
const dry = process.argv.includes("--dry");
// 位置参数是 ticker，旗标不能混进去：否则 "--DRY" 会被当成一只股票去链上找
const wanted = process.argv.slice(2).filter((s) => !s.startsWith("-")).map((s) => s.toUpperCase());
const client = new BinanceWeb3Client(apiKey, secretKey);
const rwa = new RwaApi(client);
const aggregator = new AggregatorApi(client);
const wallet = process.env.PORTFOLIO_ADDRESS?.trim() || privateKeyToAccount(generatePrivateKey()).address;

const { tokens, missing, illiquid } = await resolveTokens(rwa, wanted.length ? wanted : strategy.basket.tickers, {
  probe: { aggregator, userWalletAddress: wallet, quoteAsset: { address: strategy.basket.quoteAsset.address } },
});
if (missing.length) console.warn(`⚠ 链上无此代币: ${missing.join(", ")}`);
if (illiquid.length) console.warn(`⚠ 有代币但无可用盘口（冲击 >2%）: ${illiquid.join(", ")}`);

// 300 根日线实测跨度约 361 天（含停市空档），取 420 天留足余量
const since = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
const usPrices = await usClosesByTicker(Object.keys(tokens), since);
const rows: CandleRow[] = [];
const tickRows: TickRow[] = [];
console.log(`\n  ticker  币数   重叠   均值溢价   中位     极值        最近一日`);
for (const [ticker, ref] of Object.entries(tokens)) {
  const candles = await fetchKlines(ref.address, { interval: interval as "1d" }).catch((e) => {
    console.log(`  ${ticker.padEnd(6)} 采集失败：${(e as Error).message.slice(0, 90)}`);
    return [];
  });
  if (!candles.length) continue;
  for (const k of candles) {
    rows.push({ ticker, date: k.date, open: k.open, high: k.high, low: k.low, close: k.close, shareRatio: ref.shareRatio });
  }
  const us = usPrices.get(ticker) ?? new Map<string, number>();
  const prem = premiumFromCandles(candles, us, ref.shareRatio);
  if (!prem.length) {
    console.log(`  ${ticker.padEnd(6)} ${String(candles.length).padStart(4)}   0    —— 与库里美股收盘无同日交集 ——`);
    continue;
  }
  const v = prem.map((p) => p.premium).sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const mid = v[Math.floor(v.length / 2)] ?? 0;
  const last = prem[prem.length - 1];
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  console.log(
    `  ${ticker.padEnd(6)} ${String(candles.length).padStart(4)} ${String(prem.length).padStart(6)} ` +
      `${pct(mean).padStart(9)} ${pct(mid).padStart(8)} ${(pct(v[0] ?? 0) + "~" + pct(v[v.length - 1] ?? 0)).padStart(18)} ` +
      (last ? `最近 ${last.date} ${pct(last.premium)}` : ""),
  );
}

if (!dry) await initSchema();
// 这张表喂的是共享库里的线上看板，先只看不写：溢价序列是否可信，得能在落库前判断
const saved = dry ? 0 : await saveCandles(rows);

// 带成交量的分钟蜡烛：另一条端点、另一个问题。日线源 volume 是保留字段（恒 0），证明不了链上在撮合；
// 这一路给量，代价是固定只返回最近 300 根、且没有对应的美股分钟价，所以它不参与溢价计算。
console.log(`\n  ticker  根数  覆盖窗口（UTC）           跨度      平均bar  无成交分钟  volume 合计`);
for (const [ticker, ref] of Object.entries(tokens)) {
  try {
    const ticks = await fetchTicks(client, ref.address, { limit: 300 });
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    if (!first || !last) {
      console.log(`  ${ticker.padEnd(6)}     0   —— 端点返回空 ——`);
      continue;
    }
    const stamp = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
    const spanMin = Math.round((last.openTime - first.openTime) / 60000) + 1;
    // 源站按 1 分钟切 bar，但**只返回有成交的那些分钟**，所以跨度减根数就是空掉的分钟数
    const idle = Math.max(0, spanMin - ticks.length);
    const volume = ticks.reduce((a, t) => a + t.volume, 0);
    const human = spanMin >= 2880 ? `${(spanMin / 1440).toFixed(1)}天` : `${(spanMin / 60).toFixed(1)}小时`;
    for (const t of ticks) tickRows.push({ ...t, ticker, shareRatio: ref.shareRatio });
    console.log(
      `  ${ticker.padEnd(6)} ${String(ticks.length).padStart(3)}  ${(stamp(first.openTime) + "→" + stamp(last.openTime)).padEnd(24)} ` +
        `${human.padStart(7)} ${`${(spanMin / ticks.length).toFixed(1)}min`.padStart(8)} ` +
        `${`${idle} (${((idle / spanMin) * 100).toFixed(0)}%)`.padStart(11)} ${volume.toFixed(0).padStart(11)}`,
    );
  } catch (e) {
    console.log(`  ${ticker.padEnd(6)} 采集失败：${(e as Error).message.slice(0, 90)}`);
  }
}
const savedTicks = dry ? 0 : await saveTicks(tickRows);

console.log(
  `\n${dry ? "--dry 未写入" : `已写入 rwa_candles ${saved} 行 / rwa_ticks ${savedTicks} 行`}（${Object.keys(tokens).length} 只 × 日线 interval=${interval} + 1 分钟蜡烛）`,
);
process.exit(0);
