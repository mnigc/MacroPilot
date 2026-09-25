/**
 * 对真实 API 的连通性冒烟测试：
 *   1. pnpm/npm run smoke 不带 .env   → 打印提示退出
 *   2. 带 key                        → 调 RWA 平台列表 + 代币列表 + 报价 dry-run
 * 首次真实响应会用来收紧 src/binance/rwa.ts 的类型定义——把实际返回字段记进 DX-LOG.md
 */
import "dotenv/config";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { RwaApi, spreadPercent } from "../src/binance/rwa.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;

if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY，请先复制 .env.example 为 .env 并填写。");
  process.exit(1);
}

const client = new BinanceWeb3Client(apiKey, secretKey);
const rwa = new RwaApi(client);

const platforms = await rwa.listPlatforms();
console.log("平台列表:", platforms);

const tokens = await rwa.listTokens({ limit: 50 });
console.log(`代币数量: ${tokens.length}`);
console.log("原始响应样例（用于收紧类型）:", JSON.stringify(tokens[0], null, 2));

for (const t of tokens.slice(0, 10)) {
  console.log(
    `${t.symbol?.padEnd(6)} 链上=${t.onChainPrice ?? "?"} 参考=${t.referencePrice ?? "?"} 价差=${(spreadPercent(t)?.toFixed(3) ?? "?") + "%"} 状态=${t.marketStatus ?? "?"}`,
  );
}
