import type { BinanceWeb3Client } from "./client.js";
import { BSC_CHAIN_ID_STR } from "./rwa.js";

/**
 * Market API 的 portfolio 组：币安**自己**按链上成交算出来的持仓与 PnL。
 * 对我们的意义是"第二份账"——FIFO 账本只有我们自己算的那一份，说错了没人能反驳。
 *
 * 2026-09-26 实测口径（全部来自真实响应，文档里一条都没写）：
 * - 地址参数只认 **walletAddress**。同一地址改传 `address`：不报错、不提示，直接返回全 0。
 * - `*Percent` 一律是**小数分数**（`0.0313` = 3.13%），和 D3 第 5 条 priceImpactPercent 同一个坑。
 *   实测某持有者 realizedPnlUsd 1,172,673 / buyTxVolume 37,481,961 = 0.0313，两个字段自洽。
 * - `overview` 按 timeFrame 开窗（枚举 `1=1D, 2=7D, 3=1M, 4=3M` 是从报错信息里读出来的）。
 *   窗口外的活动一律不算，所以同一个地址会出现"overview 全 0、token/latest-pnl 有 117 万美元"，
 *   这不是端点坏了，是那笔成交在窗口之外（该地址 lastActiveTimestamp 停在 2026-03-31）。
 * - `realizedPnlUsd` 的字符串精度高达 60 位，`Number()` 之后会掉精度：只做展示与差值比较，
 *   不要拿它做等式断言。
 */

/** 报错信息给出的枚举，文档未载 */
export type PortfolioTimeFrame = "1" | "2" | "3" | "4";

export interface PortfolioOverview {
  realizedPnlUsd?: string;
  realizedPnlPercent?: string;
  winRate?: string;
  buyTxCount?: string;
  sellTxCount?: string;
  dailyPnl?: { date: string; pnlUsd: string }[];
  tokenCountByPnlPercent?: Record<string, string>;
}

export interface TokenPnl {
  realizedPnlUsd?: string;
  realizedPnlPercent?: string;
  buyTxVolume?: string;
  buyAmount?: string;
  buyTxCount?: string;
  buyAvgPrice?: string;
  sellTxVolume?: string;
  sellAmount?: string;
  sellTxCount?: string;
  sellAvgPrice?: string;
  tokenBalanceAmount?: string;
  tokenBalanceUsd?: string;
  maxBalanceAmount?: string;
  holdingDuration?: string;
  /** 币安是否支持该代币的 PnL 计算——false 时所有 0 都不可解释为"没赚没赔" */
  isPnlSupported?: boolean;
}

export interface RecentPnlItem {
  binanceChainId: string;
  tokenContractAddress: string;
  tokenSymbol: string;
  lastActiveTimestamp: string;
  realizedPnlUsd?: string;
  realizedPnlPercent?: string;
}

export interface RwaHolder {
  holderWalletAddress: string;
  holdAmount?: string;
  holdingPercent?: string;
  boughtAmount?: string;
  avgBuyPrice?: string;
  soldAmount?: string;
  avgSellPrice?: string;
  realizedPnlUsd?: string;
}

export class PortfolioApi {
  constructor(private readonly client: BinanceWeb3Client) {}

  /** 地址级组合：窗口内的已实现盈亏、买卖笔数、日频 PnL 序列 */
  overview(
    walletAddress: string,
    timeFrame: PortfolioTimeFrame = "2",
    chainId: string = BSC_CHAIN_ID_STR,
  ): Promise<PortfolioOverview> {
    return this.client.get<PortfolioOverview>("/api/v1/dex/market/portfolio/overview", {
      binanceChainId: chainId,
      walletAddress,
      timeFrame,
    });
  }

  /** 该地址最近动过的代币，逐笔给 PnL——不受 timeFrame 窗口限制，用来确认"这地址到底有没有账" */
  recentPnl(
    walletAddress: string,
    chainId: string = BSC_CHAIN_ID_STR,
  ): Promise<{ cursor: string | null; pnlList: RecentPnlItem[] }> {
    return this.client.get("/api/v1/dex/market/portfolio/recent-pnl", {
      binanceChainId: chainId,
      walletAddress,
    });
  }

  /** 单代币账本：买卖量、均价、持仓与已实现盈亏 */
  tokenPnl(
    walletAddress: string,
    tokenContractAddress: string,
    chainId: string = BSC_CHAIN_ID_STR,
  ): Promise<TokenPnl> {
    return this.client.get<TokenPnl>("/api/v1/dex/market/portfolio/token/latest-pnl", {
      binanceChainId: chainId,
      walletAddress,
      tokenContractAddress,
    });
  }

  /**
   * 持有某枚 RWA 的真实地址排行——对账之外还能拿来当"链上谁在买"的样本。
   * 实测 `limit` 被忽略：传 10 稳定返回 100 名，所以别指望它控制响应体大小。
   */
  topHolders(
    tokenContractAddress: string,
    limit = 10,
    chainId: string = BSC_CHAIN_ID_STR,
  ): Promise<RwaHolder[]> {
    return this.client.get<RwaHolder[]>("/api/v1/dex/market/token/top-trader", {
      binanceChainId: chainId,
      tokenContractAddress,
      limit,
    });
  }
}
