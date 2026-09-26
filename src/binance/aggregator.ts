import type { BinanceWeb3Client } from "./client.js";

/**
 * 交易 API（DEX 聚合器 /api/v1/dex/aggregator/*）。
 *
 * 全部按 2026-09-26 真实调用收紧（此前的字段名来自文档猜测，几乎全错）：
 *  · 链参数名是 **binanceChainId（字符串）**，不是 chainId——传 chainId 会得到
 *    40001 "Parameter [binanceChainId] is required"；
 *  · 数量字段是 fromTokenAmount / toTokenAmount，且**没有** minToAmount
 *    （滑点下限在 swap 的 tx.minReceiveAmount 里）；
 *  · priceImpactPercent 是**字符串小数**（0.0009363173 = 0.0936%），不是百分数；
 *  · 股票代币在本轮真实询价里 executionMode 为 **SWAP**（vendor LiquidMesh，
 *    路由 Metric 池 100%），并非文档暗示的"RWA 恒为 RFQ"。RFQ 分支保留但按
 *    executionMode 走，两种模式共用同一套护栏。
 *
 * 已验证到"拿到可广播载荷"：quote / approve-transaction / swap。
 * 未验证：真实广播、RFQ 的 typedDataToSign 字段名与 order/submit 往返（需要一只充值的小额钱包）。
 */

export interface QuoteParams {
  /** 字符串形态的链 ID，如 "56" */
  binanceChainId: string;
  /** 卖出数量（最小单位） */
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** RFQ/SWAP 都必需：接收资产的最终用户钱包地址 */
  userWalletAddress: string;
}

export interface QuoteTokenInfo {
  tokenContractAddress: string;
  tokenSymbol?: string;
  /** USD 单价（字符串高精度） */
  tokenUnitPrice?: string;
  /** 合约精度，字符串 */
  decimal?: string;
  isHoneyPot?: boolean;
  taxRate?: string;
}

export interface QuoteRoute {
  quoteId: string;
  vendorName?: string;
  executionMode?: string; // SWAP | RFQ
  binanceChainId?: string;
  fromTokenAmount?: string;
  toTokenAmount?: string;
  /** 交易费（USD，字符串） */
  tradeFee?: string;
  /** 燃气上限（gas 单位，非 WEI） */
  estimateGasFee?: string;
  /** 小数形态：0.000936 = 0.0936% */
  priceImpactPercent?: string;
  router?: string;
  fromToken?: QuoteTokenInfo;
  toToken?: QuoteTokenInfo;
  /** 需要 ERC-20 授权的目标（= swap.tx.to） */
  approveTarget?: string;
  isBest?: boolean;
  dexRouterList?: { dexProtocol?: { dexName?: string; percent?: string } }[];
}

export interface ApproveParams {
  binanceChainId: string;
  /** 被授权的代币合约 */
  tokenContractAddress: string;
  /** 授权额度（最小单位）；只授权本次用量可降低风险 */
  approveAmount: string;
  userWalletAddress: string;
}

/** approve-transaction 返回**数组**：data 即 ERC-20 approve 调用 */
export interface ApproveTransaction {
  data: string;
  dexContractAddress: string;
  gasLimit?: string;
  gasPrice?: string;
}

export interface SwapParams extends QuoteParams {
  quoteId: string;
  vendorName?: string;
  /** 允许滑点百分比，如 0.5 表示 0.5% */
  slippagePercent: number;
}

/** swap.tx：可直接交给钱包广播的交易（from 字段是服务端地址，广播前必须丢弃） */
export interface SwapTransaction {
  from?: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  /** 滑点保护后的最低到手数量（最小单位） */
  minReceiveAmount?: string;
  slippagePercent?: string;
}

export interface SwapResult {
  executionMode?: string;
  /** SWAP 模式：可直接广播的交易 */
  tx?: SwapTransaction;
  /** SWAP 模式回带的行情快照 */
  routerResult?: QuoteRoute & { fromToken?: QuoteTokenInfo; toToken?: QuoteTokenInfo };
  /** RFQ 模式：需本地 EIP-712 签名后 order/submit（本轮未真实命中） */
  rfq?: {
    orderId?: string;
    vendor?: string;
    typedDataToSign?: Record<string, unknown>;
    requestNonce?: string;
  };
}

export interface RfqOrderSubmitBody {
  /** 幂等键：同一 requestId 30 分钟内重复提交不会重复成交 */
  requestId: string;
  userSignature: string;
  vendor: string;
  quoteId: string;
}

export interface RfqOrder {
  orderId: string;
  status: string; // PENDING_VENDOR | PENDING_ONCHAIN | FILLED | FAILED | EXPIRED | CANCELLED
  txHash?: string;
  fromAmount?: string;
  toAmount?: string;
  failureReason?: string;
}

/** 冲击成本换算成百分比：接口的 priceImpactPercent 是小数字符串（"0.000936" → 0.0936%） */
export function impactPercent(route: QuoteRoute): number {
  const raw = route.priceImpactPercent;
  const n = raw === undefined || raw === "" ? undefined : Number(raw);
  return n === undefined || !Number.isFinite(n) ? 0 : n * 100;
}

/** 选单：冲击成本最小优先，其次到手数量最大 */
export function pickQuote(routes: QuoteRoute[]): QuoteRoute {
  const usable = routes.filter((r) => r.quoteId && r.toTokenAmount && r.fromTokenAmount);
  if (!usable.length) throw new Error("无可用报价（quote 未返回 fromTokenAmount/toTokenAmount）");
  return [...usable].sort((a, b) => {
    const ia = impactPercent(a);
    const ib = impactPercent(b);
    if (ia !== ib) return ia - ib;
    return Number(b.toTokenAmount) - Number(a.toTokenAmount);
  })[0] as QuoteRoute;
}

/** 报价换算出的每枚代币 USDT 单价（可成交价的原始形态，未做份额比折算） */
export function routeUnitPrice(route: QuoteRoute): number | null {
  const from = Number(route.fromTokenAmount);
  const to = Number(route.toTokenAmount);
  const fromDec = Number(route.fromToken?.decimal ?? 18);
  const toDec = Number(route.toToken?.decimal ?? 18);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0) return null;
  const usdt = from / 10 ** fromDec;
  const units = to / 10 ** toDec;
  return units > 0 ? usdt / units : null;
}

export class AggregatorApi {
  constructor(private readonly client: BinanceWeb3Client) {}

  supportedChains(binanceChainId?: string) {
    return this.client.get<unknown[]>("/api/v1/dex/aggregator/supported/chain", { binanceChainId });
  }

  quote(params: QuoteParams): Promise<QuoteRoute[]> {
    return this.client.get<QuoteRoute[]>("/api/v1/dex/aggregator/quote", { ...params });
  }

  approveTransaction(params: ApproveParams): Promise<ApproveTransaction[]> {
    return this.client.get<ApproveTransaction[]>("/api/v1/dex/aggregator/approve-transaction", { ...params });
  }

  buildSwap(params: SwapParams): Promise<SwapResult> {
    return this.client.get<SwapResult>("/api/v1/dex/aggregator/swap", { ...params });
  }

  submitRfqOrder(body: RfqOrderSubmitBody): Promise<{ orderId: string; status: string }> {
    return this.client.post<{ orderId: string; status: string }>("/api/v1/dex/aggregator/order/submit", body);
  }

  rfqOrderStatus(orderId: string): Promise<RfqOrder> {
    return this.client.get<RfqOrder>(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`);
  }

  history(params: { binanceChainId: string; txHash?: string; address?: string }) {
    return this.client.get<unknown[]>("/api/v1/dex/aggregator/history", { ...params });
  }
}
