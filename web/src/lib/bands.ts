export interface Band {
  start: string;
  end: string;
  regime: string;
}

/** 把逐日体制序列压缩成连续色带（相邻同体制日期合并为一段） */
export function regimeBands(dates: string[], regimes: string[]): Band[] {
  const bands: Band[] = [];
  let startIdx = 0;
  for (let i = 1; i <= regimes.length; i++) {
    const prev = regimes[i - 1];
    const cur = regimes[i];
    if (i === regimes.length || cur !== prev) {
      if (prev !== undefined) {
        bands.push({
          start: dates[startIdx] as string,
          end: dates[i - 1] as string,
          regime: prev,
        });
      }
      startIdx = i;
    }
  }
  return bands;
}

export const REGIME_COLOR: Record<string, string> = {
  riskOn: "rgba(14, 203, 129, 0.07)",
  neutral: "rgba(75, 155, 255, 0.055)",
  riskOff: "rgba(246, 70, 93, 0.085)",
};

export const REGIME_LABEL: Record<string, string> = {
  riskOn: "Risk-On 全仓",
  neutral: "Neutral 中性",
  riskOff: "Risk-Off 防御",
};
