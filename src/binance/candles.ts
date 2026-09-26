import { fetch as undiciFetch } from "undici";
import { proxyDispatcher, type BinanceWeb3Client } from "./client.js";
import { BSC_CHAIN_ID_STR } from "./rwa.js";

/**
 * 链上 K 线（公共 wallet-direct 端点，无需签名）。
 *
 * 三条蜡烛路各有取舍，2026-09-26 实测（scripts/probe-api.ts kline）：
 *  · 签名 /dex/market/candles：唯一 volume 非零的一路，1 分钟粒度且只给有成交的分钟，
 *    固定 300 根上限；interval 与 startTime/endTime 全部无效 —— 能看今天，不能看历史；
 *  · 签名 /dex/market/rwa/kline：固定 1 分钟粒度、约 5 小时窗口，volume 恒 0；
 *  · 公共 kline/ai：interval 真的生效，1d 口径一次给 300 根（约一年），是唯一可回溯的一路。
 *    代价是 volume 为保留字段（恒 "0"），所以它只能证明价格变化，不能证明成交密度。
 *
 * 因此本模块两条都要：`fetchKlines` 给可回溯的历史（日线口径溢价），
 * `fetchTicks` 给最近几小时的真实量价（用来证明链上确实在撮合，不只是净值标记）。
 * 实时溢价仍以聚合器询价为准（src/binance/premium.ts）。
 */

const BASE = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet";
/** 官方 skills-hub 明确要求这批 /ai 端点带这个 UA，否则拿不到 JSON */
const USER_AGENT = "binance-web3/1.1 (Skill)";

export type KlineInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "12h" | "1d";

export interface Candle {
  /** 开盘时间对应的 UTC 日期，YYYY-MM-DD */
  date: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** 公共端点信封：code 是字符串 "000000"，与 /build 网关的整数 code 不是一套 */
interface PubEnvelope {
  code?: string;
  success?: boolean;
  data?: { klineInfos?: [number, string, string, string, string, string, number][] };
}

const num = (v: string | number): number => Number(v);

/**
 * 拉 K 线。默认丢掉最后一根未收盘的：拿"今天到目前为止"去和美股收盘价配对，
 * 会把一根还在走的 Bar 当成确定值，溢价曲线的最后一丁点全是假精度。
 */
export async function fetchKlines(
  contractAddress: string,
  opts: { interval?: KlineInterval; limit?: number; chainId?: string; includePartial?: boolean } = {},
): Promise<Candle[]> {
  const q = new URLSearchParams({
    chainId: opts.chainId ?? BSC_CHAIN_ID_STR,
    contractAddress,
    interval: opts.interval ?? "1d",
    limit: String(opts.limit ?? 300),
  });
  const res = await undiciFetch(`${BASE}/dex/market/token/kline/ai?${q}`, {
    headers: { "Accept-Encoding": "identity", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  } as Parameters<typeof undiciFetch>[1]);
  const text = await res.text();
  let body: PubEnvelope | null = null;
  try {
    body = JSON.parse(text) as PubEnvelope;
  } catch {
    throw new Error(`链上 K 线非 JSON 响应 HTTP ${res.status}: ${text.slice(0, 60)}`);
  }
  if (body.code !== "000000") throw new Error(`链上 K 线返回 code=${body.code ?? res.status}`);
  const rows = body.data?.klineInfos ?? [];
  const now = Date.now();
  return rows
    .map(([openTime, o, h, l, c, , closeTime]) => ({
      date: new Date(openTime).toISOString().slice(0, 10),
      openTime,
      closeTime,
      open: num(o),
      high: num(h),
      low: num(l),
      close: num(c),
    }))
    .filter((k) => Number.isFinite(k.close) && (opts.includePartial || k.closeTime <= now))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * 最近的真实链上量价蜡烛（签名 /dex/market/candles）——三条路里唯一 volume 非零的一路。
 *
 * 实测（2026-09-26，篮子 7 只各取 300 根）：
 *  · 粒度 1 分钟，且**只返回有成交的那些分钟**，所以同样 300 根，NVDA 覆盖 5.7 小时、
 *    GOOGL 7.2 小时、TSLA 10.7 小时，而 META 要往前翻 11.5 天、AMZN 18.3 天才凑够 30 个交易日；
 *    这个"覆盖跨度"本身就是流动性读数，比 volume 字段可信；
 *  · `interval` 与 `startTime/endTime` 全被忽略，limit>300 直接拒 —— 补不了历史，
 *    只能每天来拍一张快照，把当时那 300 根留在自己库里；
 *  · volume 的单位源站没写。按"枚"解读会得到 META 一天 11 亿美元名义，与我们对同一枚代币
 *    50 USDT 询价的盘口深度差三个数量级，所以它更像名义额口径。看板只照抄原值并标注存疑，
 *    执行决策一律用聚合器询价，不用这个字段。
 * 列序 [open, high, low, close, volume, openTime, ...]，与公共 K 线端点的
 * [openTime, open, high, low, close, ...] 不是同一套，别复用同一个列号表。
 */
export interface Tick {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 每枚代币口径的成交量；源站按字符串返回，折算失败记 0 */
  volume: number;
}

export async function fetchTicks(
  client: BinanceWeb3Client,
  contractAddress: string,
  opts: { chainId?: string; limit?: number } = {},
): Promise<Tick[]> {
  const rows = await client.get<unknown[][]>("/api/v1/dex/market/candles", {
    binanceChainId: opts.chainId ?? BSC_CHAIN_ID_STR,
    tokenContractAddress: contractAddress,
    limit: opts.limit ?? 300,
  });
  return rows
    .map((r) => ({
      openTime: Number(r[5]),
      open: Number(r[0]),
      high: Number(r[1]),
      low: Number(r[2]),
      close: Number(r[3]),
      volume: Number(r[4]),
    }))
    .filter((t) => Number.isFinite(t.openTime) && Number.isFinite(t.close))
    .sort((a, b) => a.openTime - b.openTime);
}

/** 入库行：分钟蜡烛按每枚代币口径存，份额比随行保存，站点才能折算成每股 */
export interface TickRow extends Tick {
  ticker: string;
  shareRatio: number;
}

/** 入库行：价格是源站的每枚代币口径，shareRatio 是采集当时 1 枚代币 = 多少股 */
export interface CandleRow {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  shareRatio: number;
}

/**
 * 日线口径的链上溢价：链上收盘按份额比折算到每股，再与美股同日收盘比。
 *
 * 与询价口径的分工要说清楚——询价给出的是"这一刻真能成交的价格"，但只有当下一个点；
 * 这条给出可回溯的序列，代价是两边收盘时刻本就不对齐（链上按 UTC 自然日切，
 * 美股按 20:00/21:00Z 收），所以它是趋势量，不能拿去当成交依据。
 */
export function premiumFromCandles(
  candles: Candle[],
  referenceByDate: Map<string, number>,
  shareRatio = 1,
): { date: string; onchain: number; reference: number; premium: number }[] {
  const out: { date: string; onchain: number; reference: number; premium: number }[] = [];
  for (const k of candles) {
    const ref = referenceByDate.get(k.date);
    if (!ref || !Number.isFinite(ref) || ref === 0) continue;
    const perShare = k.close / (shareRatio || 1);
    out.push({ date: k.date, onchain: perShare, reference: ref, premium: perShare / ref - 1 });
  }
  return out;
}
