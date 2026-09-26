/**
 * 官方端点实测（诊断工具，非产品链路）。全程只读：只 GET/POST 查询与 simulate，绝不广播。
 *
 *   npx tsx scripts/probe-api.ts            # 全部
 *   npx tsx scripts/probe-api.ts candles    # 只做蜡烛（Market API）
 *   npx tsx scripts/probe-api.ts portfolio  # 只做地址组合/PnL
 *   npx tsx scripts/probe-api.ts tx         # 只做 Transaction API 参数形状
 *
 * 存在的理由：DX 报告"API 陷阱"与"AI 技术栈反馈"两栏需要可复现的一手证据，
 * 而不是我在文档措辞上的推测。每条断言都应能在这里跑出来。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { BinanceWeb3Client, proxyDispatcher } from "../src/binance/client.js";
import { RwaApi, BSC_CHAIN_ID_STR } from "../src/binance/rwa.js";
import { AggregatorApi, pickQuote, type SwapTransaction } from "../src/binance/aggregator.js";
import { resolveTokens } from "../src/binance/tokens.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY");
  process.exit(1);
}
const strategy = JSON.parse(readFileSync("config/strategy.json", "utf8")) as {
  basket: { tickers: string[]; quoteAsset: { address: string } };
};
const client = new BinanceWeb3Client(apiKey, secretKey);
const rwa = new RwaApi(client);
const aggregator = new AggregatorApi(client);
// 一次性询价地址：只为满足 quote 的必填字段，链上什么都没有，因此 portfolio 类端点应返回空而非报错
const probeWallet = process.env.PORTFOLIO_ADDRESS?.trim() || privateKeyToAccount(generatePrivateKey()).address;

const { tokens } = await resolveTokens(rwa, strategy.basket.tickers.slice(0, 2), { chainId: BSC_CHAIN_ID_STR });
const e0 = Object.entries(tokens)[0];
if (!e0) {
  console.error("篮子解析为空");
  process.exit(1);
}
const [, ref0] = e0;
const line = (label: string, ok: boolean, detail: string) =>
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(34)} ${detail}`);

/** 试一串参数形状，报告第一个被接受的那个。失败时逐条列出每种形状的错误——
 *  只报最后一条会把"第一个形状其实差一个字段"这种关键信息藏掉（实测踩过）。 */
async function tryShapes(label: string, path: string, shapes: Record<string, string | number | undefined>[]) {
  const errs: string[] = [];
  for (const s of shapes) {
    try {
      const data = await client.get<unknown>(path, s);
      line(label, true, `参数 ${Object.keys(s).join("+")} → ${JSON.stringify(data).slice(0, 260)}`);
      return data;
    } catch (e) {
      const keys = Object.keys(s).join("+") || "无参";
      const msg = (e as Error).message.replace("币安 Web3 API 错误 ", "").slice(0, 60);
      if (!errs.includes(`${msg}`)) errs.push(`${keys} → ${msg}`);
    }
  }
  line(label, false, `全部形状失败：${errs.join(" | ")}`);
  return null;
}

const candles = (q: Record<string, string | number | undefined>) =>
  client.get<number[][]>("/api/v1/dex/market/candles", q).catch(() => [] as number[][]);

const want = process.argv[2] ?? "all";

/** 两种 K 线端点的列序不同，按列号统一 */
interface Cols { t: number; o: number; h: number; l: number; c: number; v: number }
const COL_KLINE: Cols = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
const COL_CANDLES: Cols = { t: 5, o: 0, h: 1, l: 2, c: 3, v: 4 };

/**
 * 一行摘要。这里的 ✓/✗ 判据不是"有没有返回数据"，而是 **OHLC 四个值之间是否有差异**：
 * 净值标记源的 o=h=l=c 恒成立（币安把发行方 NAV 直接抄成 K 线），只有真实撮合才会张开。
 * D3 那句"链上价不含盘口"就是被这个区别坑出来的。
 */
function summarize(label: string, rows: unknown[][] | null | undefined, cols: Cols, extra = "") {
  if (!rows?.length) return line(label, false, `0 条 ${extra}`);
  const num = (r: unknown[], i: number) => Number(r[i]);
  const ts = rows.map((r) => num(r, cols.t)).filter(Number.isFinite).sort((a, b) => a - b);
  const combos = new Set(rows.map((r) => `${num(r, cols.o)}|${num(r, cols.h)}|${num(r, cols.l)}|${num(r, cols.c)}`));
  const vol = rows.reduce((a, r) => a + (Number.isFinite(num(r, cols.v)) ? num(r, cols.v) : 0), 0);
  const fmt = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
  const [t0, t1] = [ts[0], ts[ts.length - 1]] as (number | undefined)[];
  if (t0 === undefined || t1 === undefined) return line(label, false, `n=${rows.length} 无时间戳`);
  const step = rows.length > 1 ? `${((t1 - t0) / (ts.length - 1) / 60000).toFixed(0)}min` : "-";
  line(label, combos.size > 1, `n=${rows.length} ${fmt(t0)}→${fmt(t1)} 步长${step} OHLC张开${combos.size}种 量合计${vol.toFixed(0)} ${extra}`);
}

const err = (e: unknown) => (e as Error).message.replace("币安 Web3 API 错误 ", "").slice(0, 70);

/** 公共 wallet-direct 域的信封：code 是字符串 "000000"，与 /build 网关的整数 code 不是一套 */
interface PubEnvelope {
  code?: string;
  success?: boolean;
  data?: unknown;
}

if (want === "all" || want === "kline") {
  console.log("\n=== K 线三源对照：参数叫 period 还是 interval？张开的是成交价还是净值？===");
  const addr = ref0.address;
  const kline = async (q: Record<string, string | number>) => {
    const key = Object.keys(q).join("+");
    const rows = await client
      .get<unknown[][]>("/api/v1/dex/market/rwa/kline", {
        binanceChainId: BSC_CHAIN_ID_STR,
        tokenContractAddress: addr,
        ...q,
      })
      .catch((e) => {
        line(`签名 rwa/kline [${key}]`, false, err(e));
        return null;
      });
    if (rows) summarize(`签名 rwa/kline [${key}]`, rows, COL_KLINE);
  };
  // D3 当时传的是 period；官方 skills-hub 的同类端点写的是 interval。两种都试。
  await kline({ period: "1d", limit: 300 });
  await kline({ interval: "1d", limit: 300 });
  await kline({ interval: "5m", limit: 300 });
  await summarize(
    "签名 candles [带 volume]",
    await candles({ binanceChainId: BSC_CHAIN_ID_STR, tokenContractAddress: addr, interval: "1d", limit: 300 }),
    COL_CANDLES,
  );

  // 公共 wallet-direct 域：不需要签名，文档称 interval 必填且支持 startTime/endTime 翻页。
  // 若真能翻页，"溢价历史"就能回溯补齐，而不必从今天开始攒。
  const PUB = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet";
  const raw = async (path: string, q: Record<string, string>): Promise<PubEnvelope | null> => {
    const url = `${PUB}${path}?${new URLSearchParams(q).toString()}`;
    const res = await undiciFetch(url, {
      headers: { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" },
      signal: AbortSignal.timeout(20_000),
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    } as Parameters<typeof undiciFetch>[1]).catch((e) => {
      line(`公共 ${path.split("/").pop()}`, false, `网络失败 ${err(e)}`);
      return null;
    });
    if (!res) return null;
    const text = await res.text();
    let j: PubEnvelope | null = null;
    try {
      j = JSON.parse(text) as PubEnvelope;
    } catch {
      /* 非 JSON：HTML 拦截页/网关错误 */
    }
    if (!j) {
      line(`公共 ${path.split("/").pop()} [${Object.values(q).join(",")}]`, false, `HTTP ${res.status} 非 JSON：${text.slice(0, 50)}`);
      return null;
    }
    return j;
  };
  const nowMs = Date.now();
  for (const iv of ["1d", "1h"]) {
    const q = { chainId: BSC_CHAIN_ID_STR, contractAddress: addr, interval: iv, limit: "300" };
    const j = await raw("/dex/market/token/kline/ai", q);
    const rows = (j?.data as { klineInfos?: unknown[][] } | undefined)?.klineInfos;
    summarize(`公共 kline/ai interval=${iv}`, rows, COL_KLINE, `code=${j?.code}`);
  }
  // 翻页实测：取 30~26 天前那 5 天。若返回的 openTime 真落在那个窗口，历史就是可回溯的。
  const hist = await raw("/dex/market/token/kline/ai", {
    chainId: BSC_CHAIN_ID_STR,
    contractAddress: addr,
    interval: "1d",
    limit: "5",
    startTime: String(nowMs - 30 * 86400000),
    endTime: String(nowMs - 25 * 86400000 + 86399999),
  });
  const hrows = (hist?.data as { klineInfos?: unknown[][] } | undefined)?.klineInfos;
  summarize("公共 kline/ai 翻到 30 天前", hrows, COL_KLINE, hrows?.length ? `code=${hist?.code}` : `code=${hist?.code} ${JSON.stringify(hist?.data ?? "").slice(0, 60)}`);
  const st = await raw("/market/token/rwa/asset/market/status/ai", { chainId: BSC_CHAIN_ID_STR, contractAddress: addr });
  line("公共 asset/market/status", !!st, JSON.stringify(st?.data ?? st).slice(0, 200));
}

if (want === "all" || want === "candles") {
  console.log("\n=== Market API /candles：真实链上 OHLCV（带 volume），但参数几乎全被忽略 ===");
  const base = { binanceChainId: BSC_CHAIN_ID_STR, tokenContractAddress: ref0.address };
  const first = await candles({ ...base, interval: "1d", limit: 300 });
  if (first.length) console.log(`  形状 [o,h,l,c,volume,ts,?] 首项 ${JSON.stringify(first[0])}`);
  for (const iv of ["1m", "1h", "1d", "1w"]) {
    summarize(`interval=${iv}`, await candles({ ...base, interval: iv, limit: 300 }), COL_CANDLES);
  }
  for (const lim of [100, 300, 500]) {
    summarize(`limit=${lim}`, await candles({ ...base, interval: "1d", limit: lim }), COL_CANDLES);
  }
  // startTime/endTime 是否真能翻页，决定了"3 年溢价百分位"这条产品主张可不可能成立
  const tail = Number(first[first.length - 1]?.[5] ?? 0);
  summarize(
    "startTime/endTime 翻页",
    await candles({ ...base, interval: "1d", limit: 300, startTime: tail - 30 * 86400000, endTime: tail - 29 * 86400000 }),
    COL_CANDLES,
    "（若与上面 interval=1d 完全同一窗口，则参数被忽略）",
  );
}

/** 错误信息里出现的必填字段名 → 我们手上能给的合理取值 */
const VALUE_FOR: Record<string, string> = {
  binanceChainId: BSC_CHAIN_ID_STR,
  chainId: BSC_CHAIN_ID_STR,
  address: probeWallet,
  walletAddress: probeWallet,
  tokenContractAddress: ref0.address,
  contractAddress: ref0.address,
  timeFrame: "1",
  limit: "3",
};

/**
 * 用 40001 的错误信息反向爬出必填参数名。
 * 文档只列了端点，没给参数表；错误信息里的 "Parameter X is required" 是唯一可靠的字段名来源。
 * 每轮只补一个字段，因此日志能完整还原本来的必填集合。
 *
 * 踩过的坑：seed 里写 address、服务端真正读的是 walletAddress，缺失时由这里补成默认钱包——
 * 于是"查别人"实际查的是我们自己的空钱包，返回全 0 且看不出错。故 overrides 优先级最高。
 */
async function discover(label: string, path: string, seed: Record<string, string> = {}, overrides: Record<string, string> = {}) {
  const p: Record<string, string> = { ...seed };
  for (let round = 0; round < 8; round++) {
    try {
      const data = await client.get<unknown>(path, p);
      line(label, true, `${Object.keys(p).join("+") || "无参"} → ${JSON.stringify(data).slice(0, 300)}`);
      return data;
    } catch (e) {
      const msg = (e as Error).message.replace("币安 Web3 API 错误 ", "");
      const missing = /(\w+) is required/.exec(msg)?.[1];
      const fill = missing ? overrides[missing] ?? VALUE_FOR[missing] : undefined;
      if (!missing || fill === undefined || p[missing] !== undefined) {
        line(label, false, `${Object.keys(p).join("+") || "无参"} → ${msg.slice(0, 80)}`);
        return null;
      }
      p[missing] = fill;
    }
  }
  line(label, false, "必填字段爬取超过 8 轮");
  return null;
}

if (want === "all" || want === "portfolio") {
  console.log("\n=== Market API /portfolio：地址级组合与 PnL（币安自算，可作独立对账源） ===");
  const P = (s: string) => `/api/v1/dex/market/portfolio/${s}`;
  await tryShapes("portfolio/supported/chain", P("supported/chain"), [{}]);
  // timeFrame 必填；报错信息直接给出了枚举 "1=1D, 2=7D, 3=1M, 4=3M"（文档里查不到）
  for (const tf of ["1", "2", "4"]) {
    await discover(`overview timeFrame=${tf}`, P("overview"), { walletAddress: probeWallet }, { timeFrame: tf });
  }
  await discover("recent-pnl", P("recent-pnl"), { walletAddress: probeWallet });
  await discover("token/latest-pnl", P("token/latest-pnl"), {
    walletAddress: probeWallet,
    tokenContractAddress: ref0.address,
  });

  // 我们的钱包从未广播过，portfolio 只能验出"0 对 0"这种空假设。
  // top-trader 给的是真实持有该 RWA 的地址，用它才能判断这些端点是否真的在算账。
  const traders = (await tryShapes("token/top-trader", "/api/v1/dex/market/token/top-trader", [
    { binanceChainId: BSC_CHAIN_ID_STR, tokenContractAddress: ref0.address, limit: 10 },
  ])) as { holderWalletAddress?: string; holdAmount?: string; realizedPnlUsd?: string }[] | null;
  const ranked = (traders ?? []).filter((t) => t.holderWalletAddress);
  const holder =
    ranked.find((t) => Number(t.realizedPnlUsd ?? 0) !== 0)?.holderWalletAddress ??
    ranked.find((t) => Number(t.holdAmount ?? 0) > 0)?.holderWalletAddress ??
    ranked[0]?.holderWalletAddress;
  if (!holder) line("真实持有者", false, "top-trader 没返回可用地址");
  else {
    console.log(`  改用真实持有者 ${holder.slice(0, 12)}…`);
    // 字段名之争：address 与 walletAddress 服务端只认后者；同时只给 address 会静默返回空
    await discover("latest-pnl 只给 walletAddress", P("token/latest-pnl"), {
      walletAddress: holder,
      tokenContractAddress: ref0.address,
    });
    await discover("latest-pnl 只给 address(应无效)", P("token/latest-pnl"), {
      address: holder,
      tokenContractAddress: ref0.address,
    });
    await discover("overview(真实地址)", P("overview"), { walletAddress: holder }, { timeFrame: "2" });
    await discover("recent-pnl(真实地址)", P("recent-pnl"), { walletAddress: holder });
    for (const tt of ["SMART_MONEY", "WHALE", "KOL", "COPY_TRADING"]) {
      await discover(`address-tracker type=${tt}`, "/api/v1/dex/market/address-tracker/trades", {
        walletAddress: holder,
        trackerType: tt,
      });
    }
  }
}

if (want === "all" || want === "tx") {
  console.log("\n=== Transaction API（pre-transaction）：模拟与广播的形状 ===");
  await tryShapes("pre-transaction/supported/chain", "/api/v1/dex/pre-transaction/supported/chain", [{}]);
  await tryShapes("pre-transaction/gas-price", "/api/v1/dex/pre-transaction/gas-price", [
    { binanceChainId: BSC_CHAIN_ID_STR },
    { chainId: BSC_CHAIN_ID_STR },
  ]);
  const quoteArgs = {
    binanceChainId: BSC_CHAIN_ID_STR,
    amount: (50n * 10n ** 18n).toString(),
    fromTokenAddress: strategy.basket.quoteAsset.address,
    toTokenAddress: ref0.address,
    userWalletAddress: probeWallet,
  };
  const routes = await aggregator.quote(quoteArgs).catch((e) => {
    line("aggregator/quote", false, (e as Error).message.slice(0, 90));
    return [];
  });
  let tx: SwapTransaction | null = null;
  if (routes.length) {
    const r = pickQuote(routes);
    line("aggregator/quote", true, `${routes.length} 条路由，最优 ${r.vendorName}/${r.dexRouterList?.[0]?.dexProtocol?.dexName ?? "?"} mode=${r.executionMode}`);
    const swap = await aggregator
      .buildSwap({ ...quoteArgs, quoteId: r.quoteId, vendorName: r.vendorName, slippagePercent: 0.5 })
      .catch((e) => {
        line("aggregator/swap 构造", false, (e as Error).message.slice(0, 90));
        return null;
      });
    if (swap) {
      console.log(`  swap 返回: executionMode=${swap.executionMode} tx 字段=${swap.tx ? Object.keys(swap.tx).join(",") : "无"}`);
      tx = swap.tx ?? null;
    }
  }
  if (tx?.to && tx?.data) {
    // 上一轮实测：{binanceChainId, from, to, data, value} 得到 "50000: evmParams is required for EVM
    // chains" —— 字段名由服务端自己报出来，于是这一轮按它给的提示试数组形态，三种嵌套全一样报错。
    // 报错只说"没给"，不说"给的形状不对"，所以这一轮把对象/数组/字符串三种容器和 data/input
    // 两种字段名铺开试：如果仍然全部失败，就能确定"evmParams is required"不是缺字段的提示。
    const e0 = { to: tx.to, data: tx.data, value: tx.value ?? "0", gas: tx.gas, gasPrice: tx.gasPrice };
    const e1 = { from: probeWallet, ...e0 };
    const e2 = { from: probeWallet, to: tx.to, input: tx.data, value: tx.value ?? "0" };
    const bodies: [string, Record<string, unknown>][] = [
      ["对象 evmParams(无 from)", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: e0 }],
      ["对象 evmParams(from 在内)", { binanceChainId: BSC_CHAIN_ID_STR, evmParams: e1 }],
      ["数组 + input", { binanceChainId: BSC_CHAIN_ID_STR, evmParams: [e2] }],
      ["对象 + input", { binanceChainId: BSC_CHAIN_ID_STR, evmParams: e2 }],
      ["字符串化 evmParams", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: JSON.stringify([e1]) }],
      ["chainId 而非 binanceChainId", { chainId: BSC_CHAIN_ID_STR, evmParams: e1 }],
      ["裸 tx 字段 + userWalletAddress", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, ...e0 }],
    ];
    for (const [shape, body] of bodies) {
      try {
        const r = await client.post<unknown>("/api/v1/dex/pre-transaction/simulate", body);
        line(`simulate ${shape}`, true, JSON.stringify(r).slice(0, 400));
      } catch (e) {
        line(`simulate ${shape}`, false, (e as Error).message.replace("币安 Web3 API 错误 ", "").slice(0, 110));
      }
    }
    // 上面 10 种 body 嵌套全部得到同一句 "evmParams is required"，而把 binanceChainId 换成 chainId
    // 立刻变成 40001 —— 说明服务端确实读到了 body 里的 binanceChainId，却无论如何看不见 evmParams。
    // 唯一还没试过的通道是 query string（这个端点可能不走 /build 的 JSON body 解析）。
    const inQuery: [string, Record<string, string>][] = [
      ["query evmParams=JSON数组", { evmParams: JSON.stringify([e1]) }],
      ["query 展开字段", { from: probeWallet, to: tx.to, data: tx.data, value: tx.value ?? "0" }],
    ];
    for (const [shape, q] of inQuery) {
      try {
        const r = await client.post<unknown>(
          "/api/v1/dex/pre-transaction/simulate",
          { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: [e1] },
          q,
        );
        line(`simulate ${shape}`, true, JSON.stringify(r).slice(0, 400));
      } catch (e) {
        line(`simulate ${shape}`, false, (e as Error).message.replace("币安 Web3 API 错误 ", "").slice(0, 110));
      }
    }
    // 最后一轮：把"可能是分支开关没打开"和"容器里还有一层"两种可能各压一次。
    // gas-price 的返回里有 eip1559GasPrice 字段，所以顺带试 1559 的字段名。
    const e1559 = { from: probeWallet, to: tx.to, data: tx.data, value: tx.value ?? "0", gasLimit: tx.gas, maxFeePerGas: tx.gasPrice, maxPriorityFeePerGas: tx.gasPrice };
    const lastTry: [string, Record<string, unknown>][] = [
      ["chainType=EVM + 数组", { binanceChainId: BSC_CHAIN_ID_STR, chainType: "EVM", userWalletAddress: probeWallet, evmParams: [e1] }],
      ["evmParams.transactions", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: { transactions: [e1] } }],
      ["evmParams.calls", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: { calls: [e1] } }],
      ["EIP-1559 字段名", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, evmParams: [e1559] }],
      ["容器名换成 transactions", { binanceChainId: BSC_CHAIN_ID_STR, userWalletAddress: probeWallet, transactions: [e1] }],
    ];
    for (const [shape, body] of lastTry) {
      try {
        const r = await client.post<unknown>("/api/v1/dex/pre-transaction/simulate", body);
        line(`simulate ${shape}`, true, JSON.stringify(r).slice(0, 400));
      } catch (e) {
        line(`simulate ${shape}`, false, (e as Error).message.replace("币安 Web3 API 错误 ", "").slice(0, 110));
      }
    }
  } else {
    line("simulate", false, "没拿到可模拟的 tx（可能返回的是 RFQ 分支）");
  }
}
process.exit(0);
