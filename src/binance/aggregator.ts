import type { BinanceWeb3Client } from "./client.js";

/**
 * 交易 API（DEX 聚合器，GET/POST /api/v1/dex/aggregator/*）。
 *
 * 关键事实：股票/RWA 代币的报价 executionMode 恒为 RFQ（做市商询价模式），
 * 与普通代币的 AMM 兑换不同，执行链路为：
 *   1. GET /quote          —— 必须传 userWalletAddress（RFQ 必需）
 *   2. GET /approve-transaction —— vendor 取报价返回的 vendorName（如 PcsXRfq）
 *   3. GET /swap           —— quoteId 有效期约 30 秒，返回 rfq.typedDataToSign
 *   4. 本地 EIP-712 签名 typedData
 *   5. POST /order/submit  —— requestId 为幂等键（30 分钟有效）
 *   6. GET /order/{orderId} —— 轮询至 FILLED / FAILED / EXPIRED / CANCELLED
 */

export interface QuoteParams {
  chainId: number;
  /** 卖出数量（最小单位，如 USDT 18 位精度） */
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** RFQ 报价必需：接收资产的最终用户钱包地址 */
  userWalletAddress: string;
}

export interface QuoteRoute {
  quoteId: string;
  vendorName?: string;
  executionMode?: string; // RFQ | AMM
  fromAmount?: string;
  toAmount?: string;
  minToAmount?: string;
  estimatedGasFeesUsd?: number;
  priceImpactPercent?: number;
  /** 结构化对象，按文档示例解析 */
  vendorQuote?: Record<string, unknown>;
}

export interface ApproveParams {
  chainId: number;
  token: string;
  /** 授权额度（最小单位）；仅授权本次用量可降低风险 */
  amount: string;
  /** RFQ 必须：报价返回的 vendorName，如 PcsXRfq、InchFusion */
  vendor?: string;
}

export interface ApproveTransaction {
  to: string;
  data: string;
  value?: string;
  gasEstimate?: string | number;
}

export interface SwapParams extends Omit<QuoteParams, "amount"> {
  amount: string;
  quoteId: string;
  /** 允许滑点百分比，如 0.5 */
  slippagePercent: number;
  approveTransaction?: ApproveTransaction;
}

export interface SwapResult {
  /** AMM 路径：直接广播的交易 */
  tx?: { to: string; data: string; value?: string };
  /** RFQ 路径：需要本地 EIP-712 签名后提交订单 */
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

export class AggregatorApi {
  constructor(private readonly client: BinanceWeb3Client) {}

  supportedChains(chainId?: number) {
    return this.client.get<unknown[]>("/api/v1/dex/aggregator/supported/chain", { chainId });
  }

  quote(params: QuoteParams): Promise<QuoteRoute[]> {
    return this.client.get<QuoteRoute[]>("/api/v1/dex/aggregator/quote", { ...params });
  }

  approveTransaction(params: ApproveParams): Promise<ApproveTransaction> {
    return this.client.get<ApproveTransaction>("/api/v1/dex/aggregator/approve-transaction", { ...params });
  }

  buildSwap(params: SwapParams): Promise<SwapResult> {
    // TODO(D2 live 验证)：approveTransaction 对象在 GET query 中的编码形式需对照真实调用确认，
    // 先以 JSON 字符串传递并记录到 DX-LOG
    const { approveTransaction, ...rest } = params;
    return this.client.get<SwapResult>("/api/v1/dex/aggregator/swap", {
      ...rest,
      approveTransaction: approveTransaction ? JSON.stringify(approveTransaction) : undefined,
    });
  }

  submitRfqOrder(body: RfqOrderSubmitBody): Promise<{ orderId: string; status: string }> {
    return this.client.post<{ orderId: string; status: string }>("/api/v1/dex/aggregator/order/submit", body);
  }

  rfqOrderStatus(orderId: string): Promise<RfqOrder> {
    return this.client.get<RfqOrder>(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`);
  }

  history(params: { chainId: number; txHash?: string; address?: string }) {
    return this.client.get<unknown[]>("/api/v1/dex/aggregator/history", { ...params });
  }
}
