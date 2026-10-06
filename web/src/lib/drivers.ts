export type Driver = "seed" | "dca" | "regime" | "volTarget" | "valuation" | "sentiment" | "retarget" | "drift" | "earnings";

/**
 * trades.reason 存的是全部触发引擎（逗号分隔）——一笔周五恰逢体制切换的调仓
 * 同时由两个引擎触发，归因必须把它们都显示出来，否则"每个引擎贡献了多少"不成立。
 */
export const DRIVER_LABEL: Record<Driver, string> = {
  seed: "初始建仓",
  dca: "定投",
  regime: "体制",
  volTarget: "波动率",
  valuation: "估值",
  sentiment: "情绪",
  retarget: "调参",
  drift: "漂移",
  earnings: "财报",
};

const ALL: string[] = ["seed", "dca", "regime", "volTarget", "valuation", "sentiment", "retarget", "drift", "earnings"];

export function parseDrivers(reason: string): Driver[] {
  return reason
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Driver => ALL.includes(s));
}
