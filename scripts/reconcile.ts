/**
 * 用币安自算的 PnL 给我们的账本做外部对账。
 *   npm run reconcile                 → 对 PORTFOLIO_ADDRESS（live 要用的那只钱包）
 *   npm run reconcile -- 0xADDR       → 对任意地址
 *   npm run reconcile -- --holder AMZN → 自动抓 AMZN 代币的链上持有者来对（验证币安那一侧真在算账）
 * 只读：不签名、不广播。
 *
 * 为什么要这第二份账：FIFO 账本只有我们自己算的那一份，说错了没人能反驳。
 * `/market/portfolio/*` 是币安对同一批链上成交独立算出来的结果，两边对得上才叫账。
 *
 * 现在跑必然对出"币安 0 笔 / 我们 N 笔"：live 从未广播过（WALLET_PRIVATE_KEY 为空），
 * 纸面成交不落链。这个差额本身就是 paper 与 live 边界的证据，不是账算错了——
 * 所以输出里把它写成一行结论，而不是留着一张空表让人以为脚本坏了。
 *
 * 单位不同：我们的 units 是**股**（目标权重与估值都是每股口径），币安的 buyAmount 是**枚**。
 * 1 枚 ≈ shareRatio 股，比值直接从最近一轮溢价快照的 mark_price / reference_price 取，
 * 不再多打一次接口——份额比会逐日漂移，对账用的是成交那一刻的比值，两边都取同一轮即可。
 */
import "dotenv/config";
import { BinanceWeb3Client } from "../src/binance/client.js";
import { toNumber } from "../src/binance/rwa.js";
import { PortfolioApi } from "../src/binance/portfolio.js";
import { getPool } from "../src/db/index.js";

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
if (!apiKey || !secretKey) {
  console.error("缺少 BINANCE_API_KEY / BINANCE_SECRET_KEY");
  process.exit(1);
}
const wallet0 = (process.argv[2] ?? process.env.PORTFOLIO_ADDRESS ?? "").trim();
if (!wallet0) {
  console.error("用法：npm run reconcile -- [地址|--holder [标的]]，或在 .env 里设 PORTFOLIO_ADDRESS");
  process.exit(1);
}

const db = getPool();
const portfolio = new PortfolioApi(new BinanceWeb3Client(apiKey, secretKey));

/** 我们这一侧：按 mode + 标的汇总 FIFO 账本 */
const ours = await db.query<{
  mode: string;
  ticker: string;
  trades: number;
  bought_units: string | null;
  bought_usdt: string | null;
  sold_units: string | null;
  sold_usdt: string | null;
}>(
  `select mode, ticker, count(*)::int as trades,
          sum(units_delta) filter (where units_delta > 0) as bought_units,
          sum(notional_usdt) filter (where units_delta > 0) as bought_usdt,
          sum(-units_delta) filter (where units_delta < 0) as sold_units,
          sum(-notional_usdt) filter (where units_delta < 0) as sold_usdt
     from trades where mode = any($1) group by mode, ticker order by ticker`,
  [["paper", "live"]],
);

/** 当前策略实际交易的代币，以及成交口径的份额比 */
const tokenRows = await db.query<{ ticker: string; symbol: string; address: string; share_ratio: string | null }>(
  `select distinct on (ticker) ticker, symbol, address,
          mark_price / nullif(reference_price, 0) as share_ratio
     from rwa_premiums
    where captured_at = (select max(captured_at) from rwa_premiums)
    order by ticker`,
);
const byTicker = new Map(tokenRows.rows.map((r) => [r.ticker, r]));

const n = (v: string | null | undefined) => toNumber(v) ?? 0;
const f2 = (v: number) => v.toFixed(2);
const money = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

/**
 * `--holder [标的]`：没有自己的成交可对时，抓一位真实持有者来跑。
 * 不然这份对账永远打印两个 0，看不出它到底比没比。
 */
let wallet = wallet0;
if (wallet0 === "--holder") {
  const t = (process.argv[3] ?? "").toUpperCase();
  const ticker = t && byTicker.has(t) ? t : ([...byTicker.keys()][0] ?? "");
  const rec = byTicker.get(ticker);
  const holders = rec?.address ? await portfolio.topHolders(rec.address, 10) : [];
  const rank = holders.findIndex((h) => n(h.boughtAmount) > 0);
  const pick = holders[rank]?.holderWalletAddress;
  if (!pick) {
    console.error(`${ticker} 的 top-trader 里没有可用持有者地址`);
    process.exit(1);
  }
  console.log(`（对账对象：${ticker} 链上持有榜第 ${rank + 1}/${holders.length} 名）`);
  wallet = pick;
}

const overview = await portfolio.overview(wallet, "4");
console.log(`对账地址 ${wallet}`);
console.log(
  `币安侧 近 3 个月：已实现 ${money(n(overview.realizedPnlUsd))} USD / 买 ${overview.buyTxCount ?? "?"} 笔 / 卖 ${overview.sellTxCount ?? "?"} 笔` +
    `（收益率 ${(n(overview.realizedPnlPercent) * 100).toFixed(2)}%——接口给的是小数分数，且精度长到 130 位）`,
);
console.log(`我们侧：${ours.rows.length} 行（paper + live 汇总）`);
console.log();
console.log("  标的  我们(股/USDT/笔)      币安(枚/USDT/笔)        折算股数   已实现PnL  备注");

let ourUsdt = 0;
let theirUsdt = 0;
let theirTx = 0;
for (const [ticker, addr] of byTicker) {
  if (!addr.address) continue;
  const pnl = await portfolio.tokenPnl(wallet, addr.address);
  const mine = ours.rows.filter((r) => r.ticker === ticker);
  const myUnits = mine.reduce((s, r) => s + n(r.bought_units), 0);
  const mySpend = mine.reduce((s, r) => s + n(r.bought_usdt), 0);
  const myTrades = mine.reduce((s, r) => s + r.trades, 0);
  const theirUnits = n(pnl.buyAmount);
  const theirSpend = n(pnl.buyTxVolume);
  const theirCount = n(pnl.buyTxCount);
  const ratio = toNumber(addr.share_ratio) ?? 1;
  ourUsdt += mySpend;
  theirUsdt += theirSpend;
  theirTx += theirCount;
  const note =
    pnl.isPnlSupported === false
      ? "币安不支持该代币的 PnL，全 0 不可解读"
      : theirCount === 0 && myTrades > 0
        ? "链上无成交（纸面不落链）"
        : myTrades === 0 && theirCount > 0
          ? "币安有账我们没有"
          : "";
  console.log(
    `  ${ticker.padEnd(6)} ${(f2(myUnits) + " / " + money(mySpend) + " / " + myTrades).padEnd(20)}` +
      `${(f2(theirUnits) + " / " + money(theirSpend) + " / " + theirCount).padEnd(22)}` +
      `${f2(theirUnits * ratio).padStart(9)}  ${money(n(pnl.realizedPnlUsd)).padStart(9)}  ${note}`,
  );
}

console.log();
console.log(
  `合计：我们付出 ${money(ourUsdt)} USDT（${ours.rows.reduce((s, r) => s + r.trades, 0)} 笔，含 paper）` +
    ` vs 币安侧 ${money(theirUsdt)} USDT（${theirTx} 笔）。`,
);
console.log(
  theirTx === 0 && ourUsdt > 0
    ? "结论：该地址在链上一笔都没成交，而我们账本里的全部成交都来自 paper 模式——纸面成交不落链，" +
        "所以这份对账目前只能证明「live 还没开始」，不能证明账算对了。等第一笔真实广播之后它才有意义。"
    : "结论：两边都有成交，差额需要逐笔归因（份额比漂移 / 手续费 / 我们未记录的链上转账）。",
);
process.exit(0);
