/**
 * 一次性实验（不入库不提交）：择时叠加层在 A股单边震荡市有没有用？
 * 用沪深300 指数 2005→今做市场代理，只测可迁移的价格类层：波动率目标 + 200 日线闸门。
 * 美国宏观信号层（WALCL/VIX/DGS10/信用）不在本实验范围——那套对 A股本来就不成立。
 *
 * 执行假设：信号收盘算，次日收益按仓位计；换仓双边 15bps；指数口径（价格指数，不含股息，
 * 对三条腿影响一致）；未建模 T+1/涨跌停（极端日实际不可成交，会轻微高估择时腿）。
 */
import { readFileSync } from "node:fs";
import { computeMetrics } from "../../src/backtest/metrics.js";

type Bar = { date: string; close: number };

const raw: string[] = JSON.parse(readFileSync("csi300.json", "utf8")).data.klines;
const bars: Bar[] = raw.map((r) => ({ date: r.split(",")[0] as string, close: Number(r.split(",")[2]) }));

/** 200 日均线（序列位置）与 21 日已实现年化波动 */
const sma200 = (i: number): number | undefined => {
  if (i < 199) return undefined;
  let s = 0;
  for (let j = i - 199; j <= i; j++) s += (bars[j] as Bar).close;
  return s / 200;
};
const realized = (i: number): number | undefined => {
  if (i < 22) return undefined;
  const rets: number[] = [];
  for (let j = i - 21; j <= i; j++) {
    const a = (bars[j - 1] as Bar).close;
    const b = (bars[j] as Bar).close;
    rets.push(b / a - 1);
  }
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const varr = rets.reduce((x, y) => x + (y - mean) * (y - mean), 0) / (rets.length - 1);
  return Math.sqrt(varr * 252);
};

const COST = 15 / 10_000; // 单边 15bps

/** 仓位序列：策略函数给出目标仓位（基于截至 i 日的信息），次日生效 */
function run(posFn: (i: number) => number | undefined, label: string, from: string, to: string): void {
  let equity = 1;
  let pos = 0;
  const curve: { date: string; value: number }[] = [];
  let turnover = 0;
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    const prev = bars[i - 1] as Bar;
    if (bar.date < from || bar.date > to) {
      if (bar.date > to) break;
      continue;
    }
    const ret = bar.close / prev.close - 1;
    const target = posFn(i - 1); // 前一日收盘算出的仓位，今日持有
    const newPos = target === undefined ? pos : target;
    turnover += Math.abs(newPos - pos);
    equity *= 1 + ret * newPos - Math.abs(newPos - pos) * COST;
    pos = newPos;
    curve.push({ date: bar.date, value: equity });
  }
  const m = computeMetrics(curve);
  console.log(
    `  ${label.padEnd(22)} CAGR ${(m.cagr * 100).toFixed(1)}% · 回撤 ${(m.maxDrawdown * 100).toFixed(1)}% · 夏普 ${m.sharpe.toFixed(2)} · 换手 ${(turnover / Math.max(1, curve.length / 244)).toFixed(1)}×/年`,
  );
}

const bh = () => 1;
const volOnly = (i: number): number | undefined => {
  const rv = realized(i);
  return rv === undefined ? 1 : Math.min(1, Math.max(0.5, 0.15 / rv));
};
const volGate = (i: number): number | undefined => {
  const ma = sma200(i);
  const px = (bars[i] as Bar).close;
  const gate = ma === undefined ? 1 : px > ma ? 1 : 0.5; // 跌破年线仓位砍半，而不是清零
  const rv = realized(i);
  const mult = rv === undefined ? 1 : Math.min(1, Math.max(0.5, 0.15 / rv));
  return gate * mult;
};

const windows: [string, string, string][] = [
  ["全样本 2005→2026", "2005-01-04", "2026-09-28"],
  ["2005→2009（改革牛熊+金融危机）", "2005-01-04", "2009-12-31"],
  ["2010→2015（震荡+杠杆牛熊）", "2010-01-01", "2015-12-31"],
  ["2016→2020（纯震荡市）", "2016-01-01", "2020-12-31"],
  ["2021→2026（阴跌+政策脉冲）", "2021-01-01", "2026-09-28"],
];

console.log(`沪深300 指数 ${bars[0]?.date} → ${bars.at(-1)?.date}，共 ${bars.length} 个交易日；买入持有期末 ×${((bars.at(-1)!.close / bars[0]!.close)).toFixed(2)}\n`);
for (const [label, from, to] of windows) {
  console.log(label + `  [${from} → ${to}]`);
  run(bh, "买入持有", from, to);
  run(volOnly, "仅波动率目标", from, to);
  run(volGate, "波动率目标+年线闸门", from, to);
  console.log("");
}
