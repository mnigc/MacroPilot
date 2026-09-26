/**
 * 采集一轮"链上可成交溢价"快照并写入 Postgres（web/ 构建时读取）。
 *   npm run spread            → 用 config/strategy.json 的篮子
 *   npm run spread -- NVDA    → 只采这几只
 * 全程只读：只询价，不签名、不广播。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { RwaApi, BSC_CHAIN_ID_STR } from "../src/binance/rwa.js";
import { AggregatorApi } from "../src/binance/aggregator.js";
import { resolveTokens } from "../src/binance/tokens.js";
import { capturePremiums } from "../src/binance/premium.js";
import { initSchema, savePremiumSnapshot } from "../src/db/index.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY");
  process.exit(1);
}

const strategy = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[]; quoteAsset: { address: string; chainId: number } };
};
const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
const client = new BinanceWeb3Client(apiKey, secretKey);
const rwa = new RwaApi(client);
const wallet = process.env.PORTFOLIO_ADDRESS?.trim() || privateKeyToAccount(generatePrivateKey()).address;
const aggregator = new AggregatorApi(client);
const { tokens, missing, illiquid } = await resolveTokens(rwa, wanted.length ? wanted : strategy.basket.tickers, {
  probe: { aggregator, userWalletAddress: wallet, quoteAsset: { address: strategy.basket.quoteAsset.address } },
});
if (missing.length) console.warn(`⚠ 链上无此代币: ${missing.join(", ")}`);
if (illiquid.length) console.warn(`⚠ 有代币但无可用盘口（冲击 >2%）: ${illiquid.join(", ")}`);

const rows = await capturePremiums({
  rwa,
  aggregator,
  tokens,
  userWalletAddress: wallet,
  quoteAsset: { address: strategy.basket.quoteAsset.address },
  chainId: BSC_CHAIN_ID_STR,
});

const capturedAt = new Date().toISOString();
await initSchema();
const saved = await savePremiumSnapshot(capturedAt, rows);
console.log(`采集时间 ${capturedAt}${process.env.PORTFOLIO_ADDRESS ? "" : "（一次性询价地址）"}`);
console.log("  ticker  参考价     可成交    溢价      冲击     路由");
for (const r of rows) {
  console.log(
    `  ${r.ticker.padEnd(6)} ${(r.referencePrice ?? 0).toFixed(3).padEnd(10)} ${(r.executablePrice ?? 0).toFixed(3).padEnd(10)} ` +
      `${r.premium === null ? "—" : ((r.premium * 100).toFixed(3) + "%").padStart(8)}  ` +
      `${r.impactPercent === null ? "—" : (r.impactPercent.toFixed(3) + "%")}  ${r.vendor ?? "?"}/${r.dex ?? "?"}${r.error ? `  ⚠ ${r.error}` : ""}`,
  );
}
console.log(`已写入 rwa_premiums ${saved} 行`);
process.exit(0);
