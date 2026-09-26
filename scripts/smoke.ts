/**
 * 对真实 API 的连通性冒烟测试（全程只读：不签名、不广播、不下单）：
 *   npm run smoke                  → 平台 + 篮子选币（真实询价比较链上候选成色）+ 可成交溢价对照表
 *   npm run smoke -- NVDA MSFT     → 只解析这几个 ticker
 * 类型已按 2026-09-26 的真实响应写死在 src/binance/rwa.ts 与 src/binance/aggregator.ts。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { BSC_CHAIN_ID_STR, RwaApi } from "../src/binance/rwa.js";
import { AggregatorApi } from "../src/binance/aggregator.js";
import { resolveTokens } from "../src/binance/tokens.js";
import { capturePremiums } from "../src/binance/premium.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY，请先复制 .env.example 为 .env 并填写。");
  process.exit(1);
}

const client = new BinanceWeb3Client(apiKey, secretKey);
const rwa = new RwaApi(client);
const wanted = process.argv.slice(2).map((s) => s.toUpperCase());

const platforms = await rwa.listPlatforms();
console.log(
  "发行平台:",
  platforms
    .map(
      (p) =>
        `${p.platformId}(${p.tickerCount ?? "?"} ticker, BSC ${p.chainDistribution?.find((c) => c.binanceChainId === BSC_CHAIN_ID_STR)?.tokenCount ?? "?"} 枚)`,
    )
    .join(" · "),
);

const strategy = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[]; quoteAsset: { address: string; chainId: number } };
};
// 询价必须有 userWalletAddress；没配就现取一个一次性随机地址（私钥不落盘，不可能有资金）
const wallet = process.env.PORTFOLIO_ADDRESS?.trim() || privateKeyToAccount(generatePrivateKey()).address;
if (!process.env.PORTFOLIO_ADDRESS?.trim()) console.log("\n（询价地址为一次性随机钱包；想看自己可成交额请设 PORTFOLIO_ADDRESS）");

const aggregator = new AggregatorApi(client);
const { tokens, missing, illiquid, liquidity } = await resolveTokens(rwa, wanted.length ? wanted : strategy.basket.tickers, {
  probe: { aggregator, userWalletAddress: wallet, quoteAsset: { address: strategy.basket.quoteAsset.address } },
});
console.log(`\n篮子选币（对每个 ticker 的全部链上候选逐枚询价，取冲击最低的一枚，冲击 >25% 视为链上无盘口；缓存 data/tokens.json）：`);
for (const [t, r] of Object.entries(tokens)) {
  console.log(`  ${t.padEnd(6)} ${r.symbol.padEnd(8)} ${r.address}  ${r.platform} · ${r.decimals}dec · 1 代币=${r.shareRatio.toFixed(6)} 股`);
}
for (const [t, rep] of Object.entries(liquidity)) {
  if (rep.candidates.length < 2) continue;
  console.log(`  ${t} 候选成色：`);
  for (const c of rep.candidates) {
    console.log(
      `    ${c.symbol.padEnd(8)} ${c.platform.padEnd(7)} 冲击 ${c.impactPercent === null ? "询价失败" : `${c.impactPercent.toFixed(3)}%`.padStart(8)}  ${c.error ?? `50 USDT → ${c.perTokenUsdt?.toFixed(6) ?? "?"} USDT/枚`}`,
    );
  }
}
if (missing.length) console.warn(`  ⚠ 链上无此代币: ${missing.join(", ")}`);
if (illiquid.length) console.warn(`  ⚠ 有代币但链上无盘口（冲击 >25%）: ${illiquid.join(", ")}`);

const rows = await capturePremiums({
  rwa,
  aggregator,
  tokens,
  userWalletAddress: wallet,
  quoteAsset: { address: strategy.basket.quoteAsset.address },
  chainId: BSC_CHAIN_ID_STR,
});

const pct = (v: number | null, digits = 3): string => (v === null ? "—" : `${v.toFixed(digits)}%`);
console.log("\n可成交单价 vs 官方参考价（每笔 50 USDT 询价）：");
console.log("  ticker  参考价     净值标记   可成交单价  可成交溢价  冲击     vendor/DEX");
for (const r of rows) {
  if (r.error) {
    console.log(`  ${r.ticker.padEnd(6)} 询价失败：${r.error}`);
    continue;
  }
  console.log(
    `  ${r.ticker.padEnd(6)} ${(r.referencePrice ?? 0).toFixed(3).padEnd(10)} ${(r.markPrice ?? 0).toFixed(3).padEnd(10)} ` +
      `${(r.executablePrice ?? 0).toFixed(3).padEnd(11)} ${pct(r.premium === null ? null : r.premium * 100).padStart(9)}  ` +
      `${pct(r.impactPercent)}  ${r.vendor ?? "?"}/${r.dex ?? "?"}`,
  );
}
console.log("  注：数据端点的 tokenPrice 恒等于 参考价 × 份额比（发行方净值标记，无盘口），溢价只能来自聚合器询价。");
