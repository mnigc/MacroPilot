import type { BinanceWeb3Client } from "./client.js";

/** 链 ID：BNB Chain 主网 */
export const BSC_CHAIN_ID = 56;

/**
 * RWA 数据端点（GET /api/v1/dex/market/rwa/*）。
 * 返回字段以官方文档为准，首次真实调用后按实际响应收紧类型。
 */

export interface RwaPlatform {
  platform: string; // 如 ondo | bstock
  name: string;
  tokenCount?: number;
}

export interface RwaToken {
  chainId: number;
  symbol: string;
  name?: string;
  tokenContractAddress?: string;
  platform?: string;
  sector?: string; // 板块：Magnificent 7 / AI Chips / ETF 等
  /** 链上价（DEX 现价） */
  onChainPrice?: number;
  /** 底层参考价（美股官方价格）——两者的差就是本项目的核心监控信号 */
  referencePrice?: number;
  marketStatus?: string; // premarket | regular | postmarket | overnight | closed | pause
  volume24h?: number;
  marketCap?: number;
  peRatio?: number;
}

export interface UnderlyingMarket {
  symbol: string;
  name?: string;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  peRatio?: number;
  pbRatio?: number;
  dividendYield?: number;
}

export class RwaApi {
  constructor(private readonly client: BinanceWeb3Client) {}

  /** 支持的发行平台列表（ondo / bstock） */
  listPlatforms(): Promise<RwaPlatform[]> {
    return this.client.get<RwaPlatform[]>("/api/v1/dex/market/rwa/platforms");
  }

  /** 代币列表，可按板块/平台筛选 */
  listTokens(params?: { chainId?: number; platform?: string; sector?: string; limit?: number }): Promise<RwaToken[]> {
    return this.client.get<RwaToken[]>("/api/v1/dex/market/rwa/tokens", {
      chainId: params?.chainId ?? BSC_CHAIN_ID,
      platform: params?.platform,
      sector: params?.sector,
      limit: params?.limit,
    });
  }

  /** 按关键词搜索（股票代码/公司名），用于把配置里的 ticker 解析成链上合约地址 */
  search(keyword: string, platform?: string): Promise<RwaToken[]> {
    return this.client.get<RwaToken[]>("/api/v1/dex/market/rwa/search", { keyword, platform });
  }

  /** 批量获取链上价 + 底层参考价 */
  getPrices(addresses: string[], chainId = BSC_CHAIN_ID): Promise<RwaToken[]> {
    return this.client.get<RwaToken[]>("/api/v1/dex/market/rwa/price", {
      chainId,
      tokenContractAddresses: addresses.join(","),
    });
  }

  /** 底层股票市场数据（52 周高低、估值等） */
  underlyingMarket(chainId: number, address: string): Promise<UnderlyingMarket> {
    return this.client.get<UnderlyingMarket>("/api/v1/dex/market/rwa/underlying-market", { chainId, tokenContractAddress: address });
  }
}

/** 价差 = (链上价 - 参考价) / 参考价，代币化股票相对官方价的偏离幅度 */
export function spreadPercent(t: { onChainPrice?: number; referencePrice?: number }): number | null {
  if (!t.onChainPrice || !t.referencePrice) return null;
  return (t.onChainPrice - t.referencePrice) / t.referencePrice;
}
