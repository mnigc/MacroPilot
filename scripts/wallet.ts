/**
 * 只读资金体检：确认 live 模式的钱包与余额是否就绪（不签名、不广播、不下单）。
 *   npm run wallet
 * 读 WALLET_PRIVATE_KEY 推出地址，并核对 PORTFOLIO_ADDRESS 是否同一只；
 * 再查 BNB gas 与 USDT / 篮子代币余额。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, formatUnits, http, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { BSC_CHAIN_ID_STR, RwaApi, type RwaToken } from "../src/binance/rwa.js";
import { candidatesOf } from "../src/binance/tokens.js";

const rpcUrl = (process.env.BSC_RPC_URL ?? bsc.rpcUrls.default.http[0]) as string;
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const transport = proxyUrl
  ? http(rpcUrl, {
      fetchFn: ((input: unknown, init?: unknown) =>
        undiciFetch(input as never, { ...(init as object), dispatcher: new ProxyAgent(proxyUrl) })) as never,
    } as never)
  : http(rpcUrl);
const client = createPublicClient({ chain: bsc, transport });

const privateKey = process.env.WALLET_PRIVATE_KEY as Hex | undefined;
const wallet = privateKey
  ? privateKeyToAccount(privateKey).address
  : (process.env.PORTFOLIO_ADDRESS?.trim() as Address | undefined);
if (!wallet) {
  console.error(
    ".env 里 WALLET_PRIVATE_KEY 与 PORTFOLIO_ADDRESS 都为空：live 模式无法验证。\n" +
      "请准备一只**专用小额钱包**（不要用主钱包），把它的私钥填进 WALLET_PRIVATE_KEY，\n" +
      "并充入少量 BNB（gas）+ USDT（本金）后重跑本命令；本脚本只读余额，不会签名或广播任何交易。",
  );
  process.exit(1);
}
if (process.env.PORTFOLIO_ADDRESS?.trim() && privateKey && wallet !== process.env.PORTFOLIO_ADDRESS.trim()) {
  console.warn(`⚠ 私钥推出的地址 ${wallet} 与 PORTFOLIO_ADDRESS ${process.env.PORTFOLIO_ADDRESS.trim()} 不是同一只钱包`);
}

console.log(`RPC: ${rpcUrl}`);
console.log(`地址: ${wallet}`);

const strategy = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[]; quoteAsset: { address: string; chainId: number; symbol: string } };
};

const usdt = strategy.basket.quoteAsset.address as Address;
const [bnb, usdtBal, blockNumber] = await Promise.all([
  client.getBalance({ address: wallet }),
  client.readContract({ address: usdt, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [wallet] }),
  client.getBlockNumber(),
]);
console.log(`区块高度: ${blockNumber}`);
console.log(`BNB（gas）: ${formatUnits(bnb, 18)}`);
console.log(`${strategy.basket.quoteAsset.symbol}: ${formatUnits(usdtBal, 18)}`);

let list: RwaToken[] | null = null;
try {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) {
    const rwa = new RwaApi(new BinanceWeb3Client(process.env.BINANCE_API_KEY, process.env.BINANCE_SECRET_KEY));
    list = await rwa.listTokens({ chainId: BSC_CHAIN_ID_STR, limit: 1000 });
  }
} catch (err) {
  console.warn(`（跳过持仓查询：${(err as Error).message.slice(0, 80)}）`);
}

if (list) {
  const balanceOfAbi = [{ name: "balanceOf", type: "function" as const, stateMutability: "view" as const, inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
  for (const t of strategy.basket.tickers) {
    const token = candidatesOf(list, t, BSC_CHAIN_ID_STR)[0];
    if (!token) continue;
    try {
      const raw = await client.readContract({ address: token.address as Address, abi: balanceOfAbi, functionName: "balanceOf", args: [wallet] });
      console.log(`${t.padEnd(6)} ${token.symbol.padEnd(8)} 余额 ${formatUnits(raw, token.decimals)} 枚（≈ ${(Number(formatUnits(raw, token.decimals)) * token.shareRatio).toFixed(4)} 股）`);
    } catch (err) {
      console.log(`${t.padEnd(6)} ${token.symbol.padEnd(8)} 余额读取失败：${(err as Error).message.slice(0, 60)}`);
    }
  }
}
