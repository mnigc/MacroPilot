import { createPublicClient, createWalletClient, http, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { AggregatorApi, QuoteRoute } from "../binance/aggregator.js";
import { impactPercent, pickQuote } from "../binance/aggregator.js";
import { toNumber } from "../binance/rwa.js";
import type { Trader } from "./executor.js";

/**
 * live 模式执行链路（对真实 API 逐步验证于 2026-09-26，见 DX-LOG D2）：
 *   quote → swap(构造交易) → 余额不足才 approve → 广播 → 以钱包余额差记账
 *
 * 真实询价返回的 executionMode 是 **SWAP**（vendor LiquidMesh，路由 Metric 池），
 * 不是文档暗示的"RWA 恒为 RFQ"。RFQ 分支按同一条编排保留：swap 若返回 typedDataToSign，
 * 就本地 EIP-712 签名后 order/submit 并轮询到 FILLED。两条分支共用冲击/滑点护栏与余额差记账。
 *
 * 记账口径：成交数量与均价一律取**广播前后的 ERC-20 余额差**，不信报价里的期望值——
 * 报价的 toTokenAmount 是预估，实际到手受滑点影响，用它记账会让组合净值与链上脱节。
 */

export interface LiveTraderOptions {
  aggregator: AggregatorApi;
  /** 专用小额钱包私钥，绝不可复用主钱包 */
  privateKey: Hex;
  /** 计价稳定币（USDT on BSC） */
  quoteToken: Address;
  /** ticker → 目标代币合约地址 */
  addresses: Record<string, Address>;
  /** 接口一律收字符串链 ID */
  binanceChainId?: string;
  rpcUrl?: string;
  slippagePercent?: number;
  /** 报价冲击超过该百分比即中止（护栏） */
  maxPriceImpactPercent?: number;
  minNotionalUsdt?: number;
  orderTimeoutMs?: number;
}

/** 归一化 swap 响应的 EIP-712 载荷：容忍 {domain,types,message} 或外层 typedData 包裹 */
export function extractTypedData(rfq: Record<string, unknown>): {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
  primaryType: string;
} {
  const raw = (rfq.typedDataToSign ?? rfq.typedData ?? rfq) as Record<string, unknown>;
  const domain = raw.domain as Record<string, unknown> | undefined;
  const types = raw.types as Record<string, unknown> | undefined;
  const message = (raw.message ?? raw.value) as Record<string, unknown> | undefined;
  if (!domain || !types || !message) throw new Error(`swap 响应缺少 EIP-712 载荷（实际字段: ${Object.keys(raw).join(", ")}）`);
  const { EIP712Domain: _drop, ...rest } = types; // viem 要求 types 不含 EIP712Domain
  const candidates = Object.keys(rest);
  const primaryType =
    (raw.primaryType as string | undefined) ??
    (candidates.length === 1 ? candidates[0] : candidates.find((k) => k in message && Array.isArray(rest[k])));
  if (!primaryType) throw new Error(`无法确定 primaryType（候选: ${candidates.join(", ")}）`);
  return { domain, types: rest, message, primaryType };
}

/** 冲击成本换算成百分比：接口的 priceImpactPercent 是小数字符串（0.000936 → 0.0936%） */
export { impactPercent, pickQuote } from "../binance/aggregator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 与 src/binance/client.ts 同一套代理策略：viem 的 http transport 默认走全局 fetch，不读代理环境变量 */
function rpcTransport(rpcUrl: string) {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxyUrl) return http(rpcUrl);
  const dispatcher = new ProxyAgent(proxyUrl);
  const fetchFn = ((input: unknown, init?: unknown) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher } as never)) as typeof globalThis.fetch;
  return http(rpcUrl, { fetchFn } as never);
}

export function createLiveTrader(opts: LiveTraderOptions): Trader {
  const chainId = opts.binanceChainId ?? "56";
  const account = privateKeyToAccount(opts.privateKey);
  const rpcUrl = opts.rpcUrl ?? bsc.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: bsc, transport: rpcTransport(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: bsc, transport: rpcTransport(rpcUrl) });
  const slippage = opts.slippagePercent ?? 0.5;
  const maxImpact = opts.maxPriceImpactPercent ?? 1.0;
  const minNotional = opts.minNotionalUsdt ?? 20;

  const decimalsCache = new Map<string, number>();
  const decimalsOf = async (address: Address): Promise<number> => {
    const hit = decimalsCache.get(address);
    if (hit !== undefined) return hit;
    const d = await publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" });
    decimalsCache.set(address, d);
    return d;
  };
  const toRaw = (value: number, decimals: number): bigint => BigInt(Math.round(value * 10 ** decimals));
  const fromRaw = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
  const balanceOf = (token: Address) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

  return {
    async fill({ ticker, side, notionalUsdt }) {
      if (notionalUsdt < minNotional) throw new Error(`${ticker} 单笔 ${notionalUsdt.toFixed(2)} USDT 低于最小下单额 ${minNotional}`);
      const token = opts.addresses[ticker];
      if (!token) throw new Error(`未解析到 ${ticker} 的合约地址（先运行 resolveTokens）`);
      const buy = side === "buy";
      const quoteDec = await decimalsOf(opts.quoteToken);
      const tokenDec = await decimalsOf(token);
      const fromAddr = buy ? opts.quoteToken : token;
      const toAddr = buy ? token : opts.quoteToken;

      const getRoute = (amount: bigint, from: Address, to: Address) =>
        opts.aggregator
          .quote({
            binanceChainId: chainId,
            amount: amount.toString(),
            fromTokenAddress: from,
            toTokenAddress: to,
            userWalletAddress: account.address,
          })
          .then(pickQuote);

      // 卖出按"目标美元金额"下指令，接口却按卖出代币数量报价：先用一笔同额买入定出卖方价，再折算数量
      let sellRaw: bigint;
      if (buy) {
        sellRaw = toRaw(notionalUsdt, quoteDec);
      } else {
        const sizing = await getRoute(toRaw(notionalUsdt, quoteDec), opts.quoteToken, token);
        const askPrice = Number(sizing.fromTokenAmount) / Number(sizing.toTokenAmount); // USDT / 枚
        if (!Number.isFinite(askPrice) || askPrice <= 0) throw new Error(`${ticker} 卖出定价失败（报价 ${askPrice}）`);
        sellRaw = toRaw(notionalUsdt / askPrice, tokenDec);
        const held = await balanceOf(token);
        if (held < sellRaw) throw new Error(`${ticker} 链上持仓不足：需卖 ${sellRaw.toString()}，实有 ${held.toString()}（最小单位）`);
      }

      // 1) quote —— 必须带 userWalletAddress；RFQ/SWAP 都是
      const route = await getRoute(sellRaw, fromAddr, toAddr);
      const impact = impactPercent(route);
      // 护栏：冲击成本超限即中止，宁可不交易
      if (impact > maxImpact) throw new Error(`${ticker} 报价冲击 ${impact.toFixed(3)}% > ${maxImpact}%，已中止`);
      const spendRaw = BigInt(route.fromTokenAmount as string);
      const expectRaw = BigInt(route.toTokenAmount as string);
      const quotedPrice = fromRaw(spendRaw, buy ? quoteDec : tokenDec) / fromRaw(expectRaw, buy ? tokenDec : quoteDec);

      // 2) swap —— 构造交易（此步不花费任何 Gas，也不上链）
      const swap = await opts.aggregator.buildSwap({
        binanceChainId: chainId,
        amount: spendRaw.toString(),
        fromTokenAddress: fromAddr,
        toTokenAddress: toAddr,
        userWalletAddress: account.address,
        quoteId: route.quoteId,
        vendorName: route.vendorName,
        slippagePercent: slippage,
      });

      const beforeFrom = await balanceOf(fromAddr);
      const beforeTo = await balanceOf(toAddr);
      let txHash: `0x${string}`;

      if (swap.tx?.to && swap.tx.data) {
        // SWAP 模式：可直接广播。tx.from 是服务端地址，广播前必须丢掉，否则 viem 会签错主体
        const spender = swap.tx.to as Address;
        await ensureAllowance(fromAddr, spender, spendRaw);
        txHash = await walletClient.sendTransaction({
          to: spender,
          data: swap.tx.data as Hex,
          value: BigInt(swap.tx.value ?? "0"),
          ...(swap.tx.gas ? { gas: BigInt(swap.tx.gas) } : {}),
          ...(swap.tx.gasPrice ? { gasPrice: BigInt(swap.tx.gasPrice) } : {}),
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") throw new Error(`${ticker} 链上交易失败（reverted）：${txHash}`);
      } else if (swap.rfq?.typedDataToSign) {
        // RFQ 模式：本地签名 → 提交订单 → 轮询成交（私钥不出机器）
        if (route.approveTarget) await ensureAllowance(fromAddr, route.approveTarget as Address, spendRaw);
        const typed = extractTypedData(swap.rfq.typedDataToSign);
        const userSignature = await account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        } as never); // 载荷形状来自未验证的 API 响应，类型在此收口
        const submitted = await opts.aggregator.submitRfqOrder({
          requestId: crypto.randomUUID(),
          userSignature,
          vendor: swap.rfq.vendor ?? route.vendorName ?? "",
          quoteId: route.quoteId,
        });
        const orderId = submitted.orderId ?? swap.rfq.orderId;
        if (!orderId) throw new Error("order/submit 未返回 orderId");
        const deadline = Date.now() + (opts.orderTimeoutMs ?? 90_000);
        let status = submitted.status;
        let hash: string | undefined;
        while (Date.now() < deadline) {
          const order = await opts.aggregator.rfqOrderStatus(orderId);
          status = order.status;
          hash = order.txHash ?? hash;
          if (status === "FILLED") break;
          if (["FAILED", "EXPIRED", "CANCELLED"].includes(status)) {
            throw new Error(`${ticker} 订单 ${status}${order.failureReason ? `：${order.failureReason}` : ""}`);
          }
          await sleep(1_500);
        }
        if (status !== "FILLED") throw new Error(`${ticker} 订单 ${opts.orderTimeoutMs ?? 90_000}ms 内未成交（最后状态 ${status}）`);
        txHash = (hash ?? "") as `0x${string}`;
      } else {
        throw new Error(`swap 既未返回可广播交易也未返回 RFQ 载荷（字段: ${Object.keys(swap).join(", ")}）`);
      }

      // 3) 记账：一律以余额差为准
      const spent = beforeFrom - (await balanceOf(fromAddr));
      const received = (await balanceOf(toAddr)) - beforeTo;
      if (spent <= 0n || received <= 0n) {
        throw new Error(`${ticker} 成交解析失败（付出 ${spent.toString()} 收到 ${received.toString()}），请人工核对 ${txHash}`);
      }
      const units = fromRaw(received, buy ? tokenDec : quoteDec);
      const cashAmount = fromRaw(spent, buy ? quoteDec : tokenDec);
      const price = cashAmount / units;
      if (Number.isFinite(quotedPrice) && quotedPrice > 0 && Math.abs(price / quotedPrice - 1) * 100 > slippage * 2) {
        throw new Error(`${ticker} 成交均价 ${price.toFixed(4)} 偏离报价 ${quotedPrice.toFixed(4)} 超过滑点容忍（${txHash}）`);
      }
      return { units, price, txHash };
    },
  };
  /** 授权只在额度不足时上链，且只授权本次用量 */
  async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (allowance >= amount) return;
    const txs = await opts.aggregator.approveTransaction({
      binanceChainId: chainId,
      tokenContractAddress: token,
      approveAmount: amount.toString(),
      userWalletAddress: account.address,
    });
    for (const tx of txs ?? []) {
      if (!tx?.data || !tx.dexContractAddress) continue;
      const h = await walletClient.sendTransaction({
        to: tx.dexContractAddress as Address,
        data: tx.data as Hex,
        value: 0n,
        ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
        ...(tx.gasPrice ? { gasPrice: BigInt(tx.gasPrice) } : {}),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: h });
      if (receipt.status !== "success") throw new Error(`ERC-20 授权交易失败：${h}`);
    }
  }
}
