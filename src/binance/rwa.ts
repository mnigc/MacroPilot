import type { BinanceWeb3Client } from "./client.js";

/**
 * RWA 数据端点（GET /api/v1/dex/market/rwa/*）。
 *
 * 类型按 2026-09-26 真实响应收紧（此前全凭文档猜测，字段名几乎全错）：
 * 数值一律是**高精度字符串**（"203.34064175539048445677"），链 ID 也是字符串，
 * 且取值不止 EVM（"56"=BSC、"1"=ETH、"CT_501"）。因此统一走 toNumber() 显式转换，
 * 缺字段返回 undefined，绝不当成 0。
 *
 * 参数名坑：这些端点收 **binanceChainId**（不是 chainId），传错得到
 * 40001 "Parameter binanceChainId is required"。
 */

/** 链 ID：BNB Chain 主网。接口里的 chainId 是字符串，且取值不止 EVM（"56"=BSC、"1"=ETH、"CT_501"） */
export const BSC_CHAIN_ID_STR = "56";

/** 接口里的数值均为字符串；空串/null/非法值一律 → undefined */
export function toNumber(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface RwaChainDistribution {
  binanceChainId: string;
  tokenCount?: number;
}

export interface RwaPlatform {
  platformId: string; // ondo | bstock
  tickerCount?: number;
  chainDistribution?: RwaChainDistribution[];
  website?: string;
  logoUrl?: string;
}

/** 交易态实测在 reasonCode（如 "TRADING"），marketStatus 常为 null——别拿 marketStatus 判断开市 */
export interface RwaStatusInfo {
  openState?: boolean;
  marketStatus?: string | null;
  reasonCode?: string;
  reasonMsg?: string | null;
  nextOpenTime?: number | null;
  nextCloseTime?: number | null;
}

export interface RwaToken {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId?: string;
  assetType?: number;
  tokenName?: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string;
  decimals?: string;
  underlyingTicker?: string;
  underlyingName?: string;
  underlyingNameZh?: string;
  /**
   * 1 枚代币 = 多少股底层股票。链上价除以它才是"每股口径"。
   *
   * 实测恒等式：tokenPrice ≡ referencePrice × tokenToShareRatio（7 只标的全部精确成立）。
   * 所以本端点的 tokenPrice 是**发行方净值标记**，不是成交价，据此算出的溢价必然为 0。
   * 想看真实溢价只能去聚合器询价（src/exec/live.ts 的 quote 一路）。
   */
  tokenToShareRatio?: string;
  tags?: string[];
  statusInfo?: RwaStatusInfo;
  /** 链上"价"（USD）—— 实为净值标记 */
  tokenPrice?: string;
  /** 底层股票官方参考价（USD） */
  referencePrice?: string;
  tokenPriceUpdatedAt?: number;
  volume24H?: string;
  marketCap?: string;
  peRatioTTM?: string;
}

/** /rwa/search 按 ticker 分组：同一 ticker 在多链、多平台各有合约 */
export interface RwaSearchResult {
  ticker: string;
  companyName?: string;
  assets: {
    platformId?: string;
    binanceChainId: string;
    tokenContractAddress: string;
    tokenSymbol?: string;
    assetType?: number;
  }[];
}

/** /rwa/price 的响应：只有价格与时间戳，**不含** decimals / symbol / 份额比，需与 listTokens 的元数据拼表 */
export interface RwaPricePoint {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId?: string;
  tokenPrice?: string;
  referencePrice?: string;
  /** 毫秒时间戳 */
  tokenPriceUpdatedAt?: number;
}

/** /rwa/underlying-market 分两层：状态在 statusInfo，行情在 marketData */
export interface UnderlyingMarket {
  binanceChainId?: string;
  tokenContractAddress?: string;
  platformId?: string;
  assetType?: number;
  statusInfo?: RwaStatusInfo;
  marketData?: {
    referencePrice?: string;
    high52W?: string;
    low52W?: string;
    volumeShares24H?: string;
    avgDailyVolume1Y?: string;
    totalShares?: string;
    marketCap?: string;
    turnoverRate?: string;
    amplitude?: string;
    dividendYield?: string;
    latestDividend?: string;
    peRatioTTM?: string;
    pbRatio?: string;
  };
}

/** K 线一行：[开盘毫秒, open, high, low, close, volume(实测恒为 null), 收盘毫秒] */
export type RwaKline = [number, string, string, string, string, string | null, number];

export interface RwaAttestationReport {
  supported?: boolean;
  description?: string | null;
  url?: string | null;
}

/** 文档未列出、实测存在的端点：含每日/每月储备证明 PDF，是"链上资产可验证"的现成素材 */
export interface RwaUnderlyingProfile {
  binanceChainId?: string;
  tokenContractAddress?: string;
  platformId?: string;
  underlyingTicker?: string;
  underlyingFullName?: string;
  assetType?: number;
  tokenToShareRatio?: string;
  protections?: {
    dailyAttestationReport?: RwaAttestationReport;
    monthlyAttestationReport?: RwaAttestationReport;
  };
  companyInfo?: {
    ceo?: string;
    website?: string;
    industry?: string;
    description?: string;
    descriptionZh?: string;
    conceptsEn?: string[];
    conceptsCn?: string[];
  };
}

export class RwaApi {
  constructor(private readonly client: BinanceWeb3Client) {}

  /** 支持的发行平台列表（ondo / bstock） */
  listPlatforms(): Promise<RwaPlatform[]> {
    return this.client.get<RwaPlatform[]>("/api/v1/dex/market/rwa/platforms");
  }

  /** 代币列表，可按平台/板块筛选 */
  listTokens(params?: { chainId?: string; platform?: string; sector?: string; limit?: number }): Promise<RwaToken[]> {
    return this.client.get<RwaToken[]>("/api/v1/dex/market/rwa/tokens", {
      chainId: params?.chainId ?? BSC_CHAIN_ID_STR,
      platform: params?.platform,
      sector: params?.sector,
      limit: params?.limit,
    });
  }

  /** 按关键词搜索（股票代码/公司名），返回按 ticker 分组的候选合约 */
  search(keyword: string, platform?: string): Promise<RwaSearchResult[]> {
    return this.client.get<RwaSearchResult[]>("/api/v1/dex/market/rwa/search", { keyword, platform });
  }

  /**
   * 批量获取链上价 + 底层参考价。
   * 注意参数名：/tokens 收 chainId，/price 与 /underlying-market 收 **binanceChainId**
   * （传错时接口返回 40001 "Parameter binanceChainId is required"，实测踩过）。
   */
  getPrices(addresses: string[], chainId: string = BSC_CHAIN_ID_STR): Promise<RwaPricePoint[]> {
    return this.client.get<RwaPricePoint[]>("/api/v1/dex/market/rwa/price", {
      binanceChainId: chainId,
      tokenContractAddresses: addresses.join(","),
    });
  }

  /** 底层股票市场数据（52 周高低、估值等） */
  underlyingMarket(address: string, chainId: string = BSC_CHAIN_ID_STR): Promise<UnderlyingMarket> {
    return this.client.get<UnderlyingMarket>("/api/v1/dex/market/rwa/underlying-market", {
      binanceChainId: chainId,
      tokenContractAddress: address,
    });
  }

  /** 代币档案（公司基本面 + 储备证明 PDF）。文档未列，实测可用。 */
  underlyingProfile(address: string, chainId: string = BSC_CHAIN_ID_STR): Promise<RwaUnderlyingProfile> {
    return this.client.get<RwaUnderlyingProfile>("/api/v1/dex/market/rwa/underlying-profile", {
      binanceChainId: chainId,
      tokenContractAddress: address,
    });
  }

  /**
   * K 线。实测 period 参数被忽略，返回恒定 1 分钟粒度；且 open/high/low/close 四值常相等
   * （价格源就是上面那个净值标记），所以它不适合画行情，只适合证明"有这条数据"。
   */
  kline(address: string, params?: { chainId?: string; period?: string; limit?: number }): Promise<RwaKline[]> {
    return this.client.get<RwaKline[]>("/api/v1/dex/market/rwa/kline", {
      binanceChainId: params?.chainId ?? BSC_CHAIN_ID_STR,
      tokenContractAddress: address,
      period: params?.period,
      limit: params?.limit,
    });
  }
}

/** 份额比可调量：/rwa/price 不含 ratio，需由 /rwa/tokens 或 /rwa/underlying-profile 补 */
interface PremiumInput {
  tokenPrice?: string | number | null;
  referencePrice?: string | number | null;
  tokenToShareRatio?: string | number | null;
}

/**
 * 每股口径的链上溢价：链上价按 tokenToShareRatio 折算到 1 股，再与官方参考价比。
 *
 * 实测（2026-09-26，NVDA/AAPL/MSFT/AMZN/GOOGL/META/TSLA 全部命中）：
 * 本端点的 tokenPrice **恒等于** referencePrice × tokenToShareRatio，
 * 也就是说它是发行方的净值标记而非成交价，溢价算出来恒为 0。
 * 真正可成交的链上价只能来自聚合器询价（见 src/exec/live.ts 的 quote 一路），
 * 用代币价减参考价得到的"价差"不是套利信号。
 */
export function premiumPercent(t: PremiumInput): number | null {
  const onchain = toNumber(t.tokenPrice);
  const reference = toNumber(t.referencePrice);
  const ratio = toNumber(t.tokenToShareRatio) ?? 1;
  if (onchain === undefined || reference === undefined || ratio <= 0 || reference === 0) return null;
  return onchain / ratio / reference - 1;
}

/** 未做份额比折算的原始价差；在币安 RWA 数据里它恰好等于 tokenToShareRatio-1 */
export function rawSpreadPercent(t: Omit<PremiumInput, "tokenToShareRatio">): number | null {
  const onchain = toNumber(t.tokenPrice);
  const reference = toNumber(t.referencePrice);
  if (onchain === undefined || reference === undefined || reference === 0) return null;
  return onchain / reference - 1;
}
