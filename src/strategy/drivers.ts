/**
 * 交易驱动因子：一笔调仓可能同时由多个引擎触发，归因必须是逐笔、多值的。
 *
 * 早期实现给整批交易打单一标签（优先级 seed > dca > drift），周五恰逢体制切换时
 * 全部记成 dca——那样"每个引擎贡献了多少"的统计从原理上就不成立。
 */
export type TradeDriver = "seed" | "dca" | "regime" | "volTarget" | "valuation" | "sentiment" | "retarget" | "drift" | "earnings";

/** 固定顺序拼接，便于入库后按子串聚合 */
export function joinDrivers(drivers: TradeDriver[]): string {
  const order: TradeDriver[] = ["seed", "dca", "regime", "volTarget", "valuation", "sentiment", "retarget", "earnings", "drift"];
  return order.filter((d) => drivers.includes(d)).join(",");
}

const ALL: TradeDriver[] = ["seed", "dca", "regime", "volTarget", "valuation", "sentiment", "retarget", "drift", "earnings"];

export function splitDrivers(reason: string): TradeDriver[] {
  return reason
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is TradeDriver => (ALL as string[]).includes(s));
}
