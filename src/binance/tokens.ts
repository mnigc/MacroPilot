import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BSC_CHAIN_ID_STR, toNumber, type RwaApi, type RwaToken } from "./rwa.js";
import type { AggregatorApi } from "./aggregator.js";
import { impactPercent, pickQuote, routeUnitPrice } from "./aggregator.js";

/**
 * 把策略配置里的 ticker 解析成链上代币。
 *
 * 数据源用 /rwa/tokens（一次请求拿到全链 538 枚），**不用 /rwa/search**：
 * search 是模糊匹配（搜 META 会带出 SCCO、搜 GOOGL 会带出 GOOG），
 * 且返回里没有 decimals 与 tokenToShareRatio，拿到的地址也不够算溢价。
 *
 * 同一个 ticker 在 BSC 上往往有 ondo / bstock 两枚代币，**选哪一枚必须看真实可成交性**：
 * 列表里的 volume24H 是底层美股的成交额（MSFT 两枚都是 190 亿美元量级），跟链上盘口无关。
 * 实测 MSFTon（ondo）在 BSC 上 50 USDT 只换到 4.8e-8 股（冲击 99.95%，等于没有市场），
 * 而 MSFTB（bstock）同样 50 USDT 冲击 0.00%。所以给候选排序后，用聚合器逐枚询价按冲击成本选。
 *
 * 候选列表缓存到 data/tokens.json（份额比逐日漂移，缓存带 24h TTL）；可成交性每次现探，不缓存。
 */

export interface TokenRef {
  /** 链上代币符号，如 NVDAon（ondo） / NVDAB（bstock） */
  symbol: string;
  address: string;
  chainId: string;
  platform?: string;
  name?: string;
  /** 合约精度，执行层换算 raw 数量要用 */
  decimals: number;
  /** 1 枚代币 = 多少股底层股票，算每股口径溢价要用 */
  shareRatio: number;
}

export type TokenMap = Record<string, TokenRef>;

/** 一枚候选代币的真实可成交状况（USDT → 该代币，名义金额固定） */
export interface CandidateQuote {
  symbol: string;
  platform: string;
  address: string;
  /** 报价自带的冲击成本（百分比）；询价失败为 null */
  impactPercent: number | null;
  /** 每枚代币的成交单价（USDT，未折算份额比） */
  perTokenUsdt: number | null;
  error?: string;
}

/** 逐 ticker 的选币审计：选了谁、每枚候选实测成色 */
export type LiquidityReport = Record<string, { chosen: string; candidates: CandidateQuote[] }>;

export interface ResolveOptions {
  chainId?: string;
  cachePath?: string;
  /** 给定则用聚合器询价选币；否则退回列表顺序（按 volume24H 降序） */
  probe?: {
    aggregator: AggregatorApi;
    userWalletAddress: string;
    quoteAsset: { address: string; decimals?: number };
    notionalUsdt?: number;
    /** 冲击成本超过此值（百分比）视为链上根本没有市场。只用来选币与兜底，
     *  真正的下单阈值仍由执行器的 maxPriceImpactPercent 逐笔把关 */
    maxImpactPercent?: number;
  };
}

interface TokenCache {
  fetchedAt: number;
  candidates: Record<string, TokenRef[]>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(path: string, now = Date.now()): Record<string, TokenRef[]> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TokenCache;
    if (!parsed?.candidates || typeof parsed.fetchedAt !== "number") return {};
    if (now - parsed.fetchedAt > CACHE_TTL_MS) return {};
    return parsed.candidates;
  } catch {
    return {};
  }
}

function toRef(t: RwaToken): TokenRef | null {
  const decimals = toNumber(t.decimals);
  if (decimals === undefined || !t.tokenContractAddress) return null;
  return {
    symbol: t.tokenSymbol ?? t.underlyingTicker ?? "",
    address: t.tokenContractAddress,
    chainId: t.binanceChainId,
    platform: t.platformId,
    name: t.tokenName ?? t.underlyingName,
    decimals,
    shareRatio: toNumber(t.tokenToShareRatio) ?? 1,
  };
}

/** 某 ticker 在指定链上的全部候选，按列表 volume24H 降序（仅作无询价时的兜底顺序） */
export function candidatesOf(
  tokens: RwaToken[],
  ticker: string,
  chainId = BSC_CHAIN_ID_STR,
  platform?: string,
): TokenRef[] {
  return tokens
    .filter(
      (t) =>
        t.underlyingTicker?.toUpperCase() === ticker.toUpperCase() &&
        t.binanceChainId === chainId &&
        (!platform || t.platformId === platform),
    )
    .map((t) => ({ vol: toNumber(t.volume24H) ?? 0, ref: toRef(t) }))
    .sort((a, b) => b.vol - a.vol)
    .map(({ ref }) => ref)
    .filter((r): r is TokenRef => r !== null);
}

async function probeCandidate(
  probe: NonNullable<ResolveOptions["probe"]>,
  chainId: string,
  ref: TokenRef,
): Promise<CandidateQuote> {
  const base = { symbol: ref.symbol, platform: ref.platform ?? "", address: ref.address };
  try {
    const amount = BigInt(Math.round((probe.notionalUsdt ?? 50) * 10 ** (probe.quoteAsset.decimals ?? 18)));
    const routes = await probe.aggregator.quote({
      binanceChainId: chainId,
      amount: amount.toString(),
      fromTokenAddress: probe.quoteAsset.address,
      toTokenAddress: ref.address,
      userWalletAddress: probe.userWalletAddress,
    });
    const route = pickQuote(routes);
    return { ...base, impactPercent: impactPercent(route), perTokenUsdt: routeUnitPrice(route) };
  } catch (err) {
    return { ...base, impactPercent: null, perTokenUsdt: null, error: (err as Error).message.slice(0, 120) };
  }
}

export async function resolveTokens(
  rwa: RwaApi,
  tickers: string[],
  opts: ResolveOptions = {},
): Promise<{ tokens: TokenMap; missing: string[]; illiquid: string[]; liquidity: LiquidityReport }> {
  const chainId = opts.chainId ?? BSC_CHAIN_ID_STR;
  const cachePath = opts.cachePath ?? "data/tokens.json";
  const cache = readCache(cachePath);
  if (tickers.some((t) => !cache[t]?.length)) {
    const list = await rwa.listTokens({ chainId, limit: 1000 });
    for (const t of tickers) cache[t] = candidatesOf(list, t, chainId);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), candidates: cache } satisfies TokenCache, null, 2));
  }

  const tokens: TokenMap = {};
  const missing: string[] = [];
  const illiquid: string[] = [];
  const liquidity: LiquidityReport = {};
  const maxImpact = opts.probe?.maxImpactPercent ?? 25;

  for (const t of tickers) {
    const cands = cache[t] ?? [];
    if (!cands.length) {
      missing.push(t);
      continue;
    }
    if (!opts.probe) {
      const fallback = cands[0];
      if (fallback) tokens[t] = fallback;
      else missing.push(t);
      continue;
    }
    const probed: CandidateQuote[] = [];
    const scored: { q: CandidateQuote; ref: TokenRef }[] = [];
    for (const ref of cands) {
      const q = await probeCandidate(opts.probe, chainId, ref);
      probed.push(q);
      scored.push({ q, ref });
    }
    const usable = scored
      .filter(({ q }) => q.impactPercent !== null && q.impactPercent <= maxImpact && (q.perTokenUsdt ?? 0) > 0)
      .sort((a, b) => (a.q.impactPercent ?? 0) - (b.q.impactPercent ?? 0));
    const chosen = usable[0];
    liquidity[t] = { chosen: chosen?.ref.symbol ?? "（无可用盘口）", candidates: probed };
    if (!chosen) illiquid.push(t);
    else tokens[t] = chosen.ref;
  }
  return { tokens, missing, illiquid, liquidity };
}
