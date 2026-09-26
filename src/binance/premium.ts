import type { AggregatorApi } from "./aggregator.js";
import { impactPercent, pickQuote, routeUnitPrice } from "./aggregator.js";
import type { RwaApi } from "./rwa.js";
import { BSC_CHAIN_ID_STR } from "./rwa.js";
import type { TokenMap } from "./tokens.js";

/**
 * "链上与参考价监控"的真正口径。
 *
 * 数据端点的 tokenPrice 是发行方净值标记（恒等于 参考价 × 份额比），拿它减参考价得不到任何信号。
 * 能代表链上情绪的只有**聚合器询价出的可成交单价**：
 *   每股可成交价 = (付出 USDT / 到手代币) ÷ tokenToShareRatio
 *   溢价 = 每股可成交价 / 官方参考价 − 1
 * 溢价走高说明链上买盘愿意为同一股股票付出高于美股官方价的成本（挤兑式抢筹），
 * 走高时建仓、走低时加仓，才是这套监控对定投引擎的实际价值。
 */

export interface PremiumRow {
  ticker: string;
  symbol: string;
  platform: string;
  address: string;
  /** 底层股票官方参考价（USD/股） */
  referencePrice: number | null;
  /** 发行方净值标记（USD/代币），仅作对照 */
  markPrice: number | null;
  /** 每股可成交单价（USD） */
  executablePrice: number | null;
  /** 可成交溢价：executablePrice / referencePrice − 1 */
  premium: number | null;
  /** 这笔报价自身的冲击成本（百分比） */
  impactPercent: number | null;
  vendor: string | null;
  dex: string | null;
  error?: string;
}

export async function capturePremiums(opts: {
  rwa: RwaApi;
  aggregator: AggregatorApi;
  tokens: TokenMap;
  /** 询价必填的用户钱包地址（只询价不广播） */
  userWalletAddress: string;
  quoteAsset: { address: string; decimals?: number };
  chainId?: string;
  /** 每笔询价的名义金额（USDT） */
  notionalUsdt?: number;
}): Promise<PremiumRow[]> {
  const chainId = opts.chainId ?? BSC_CHAIN_ID_STR;
  const quoteDec = opts.quoteAsset.decimals ?? 18;
  const notional = opts.notionalUsdt ?? 50;
  const entries = Object.entries(opts.tokens);
  if (!entries.length) return [];

  const marks = await opts.rwa.getPrices(entries.map(([, r]) => r.address));
  const markByAddr = new Map(marks.map((m) => [m.tokenContractAddress, m]));

  const rows: PremiumRow[] = [];
  for (const [ticker, ref] of entries) {
    const mark = markByAddr.get(ref.address);
    const base: PremiumRow = {
      ticker,
      symbol: ref.symbol,
      platform: ref.platform ?? "",
      address: ref.address,
      referencePrice: mark?.referencePrice === undefined ? null : Number(mark.referencePrice),
      markPrice: mark?.tokenPrice === undefined ? null : Number(mark.tokenPrice),
      executablePrice: null,
      premium: null,
      impactPercent: null,
      vendor: null,
      dex: null,
    };
    try {
      const routes = await opts.aggregator.quote({
        binanceChainId: chainId,
        amount: (BigInt(Math.round(notional * 10 ** quoteDec))).toString(),
        fromTokenAddress: opts.quoteAsset.address,
        toTokenAddress: ref.address,
        userWalletAddress: opts.userWalletAddress,
      });
      const route = pickQuote(routes);
      const perToken = routeUnitPrice(route);
      base.executablePrice = perToken === null ? null : perToken / (ref.shareRatio || 1);
      base.premium =
        base.executablePrice !== null && base.referencePrice ? base.executablePrice / base.referencePrice - 1 : null;
      base.impactPercent = impactPercent(route);
      base.vendor = route.vendorName ?? null;
      base.dex = route.dexRouterList?.[0]?.dexProtocol?.dexName ?? null;
    } catch (err) {
      base.error = (err as Error).message.slice(0, 160);
    }
    rows.push(base);
  }
  return rows;
}
