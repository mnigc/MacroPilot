import { alignToCalendar, changeAbs, changeOver, percentileRank, sma, type Point } from "../data/stats.js";

/** 体制三态：risk-on 全仓 / neutral 中性 / risk-off 防御 */
export type Regime = "riskOn" | "neutral" | "riskOff";

export interface MacroBundle {
  liquidity: Point[]; // WALCL，周频
  volatility: Point[]; // VIX，日频
  rates: Point[]; // DGS10，日频
  trend: Point[]; // SP500，日频（兼作主日历）
}

export interface SignalWeights {
  liquidity: number;
  volatility: number;
  rates: number;
  trend: number;
}

export interface RegimeConfig {
  weights: SignalWeights;
  /** 综合分 ≥ scoreHigh → risk-on；≤ scoreLow → risk-off；区间内保持原状态（滞回防频繁翻转） */
  scoreHigh: number;
  scoreLow: number;
  /** risk-on/neutral/risk-off 对应的目标股票仓位 */
  allocation: Record<Regime, number>;
}

export interface SignalScores {
  liquidity: number;
  volatility: number;
  rates: number;
  trend: number;
}

export interface RegimePoint {
  date: string;
  score: number;
  regime: Regime;
  equityTarget: number;
  signals: SignalScores;
}

// 观察窗口（交易日）：
const RANK_WINDOW = 756; // 百分位回看 3 年
const CHANGE_LAG = 65; // 变化窗口 ≈ 13 周
const VOL_TREND_LAG = 20; // VIX 短趋势 ≈ 1 个月
const SMA_WINDOW = 200; // 长趋势均线
const WARMUP = RANK_WINDOW + CHANGE_LAG + 1; // 第一个可用信号日

/**
 * 体制时间线：每个交易日输出综合分与目标仓位。
 *
 * 四信号全部归一为 [0,1]（分数越高越偏 risk-on）：
 *   liquidity  联储资产负债表 13 周变化的 3 年百分位（放水=高分）
 *   volatility VIX 水平（70%）+ 1 个月趋势（30%）的双百分位（恐慌=低分）
 *   rates      10Y 收益率 13 周变化的反向百分位（利率下行=高分）
 *   trend      标普相对 200 日均线偏离的百分位（强势=高分）
 *
 * 设计取舍：用百分位而非阈值/zygo 分数——量纲无关、无需调参、对 VIX 这类
 * 厚尾序列稳健。语义注意：百分位衡量"当前相对自己过去 3 年的位置"，因此
 * 匀速漂移（无论扩张还是上涨）读数≈中性，只有加速式转变才会推向极值——
 * 这正是想要的：状态机只在体制变化时动作，稳态时保持低换手。
 */
export function computeRegimeTimeline(bundle: MacroBundle, cfg: RegimeConfig): RegimePoint[] {
  const calendar = bundle.trend.map((p) => p.date);

  const liquidityChg = changeOver(bundle.liquidity, 13); // 周频序列：13 个位置 = 13 周
  const vixLevel = new Map(bundle.volatility.map((p) => [p.date, p.value]));
  const vixChg = changeAbs(bundle.volatility, VOL_TREND_LAG);
  const rateChg = changeAbs(bundle.rates, CHANGE_LAG);
  const trendSma = sma(bundle.trend, SMA_WINDOW);
  const trendAlign = alignToCalendar(bundle.trend, calendar);
  const smaAlign = alignToCalendar([...trendSma].map(([date, value]) => ({ date, value })), calendar);

  const liqAlign = alignToCalendar(
    bundle.liquidity.filter((p) => liquidityChg.has(p.date)).map((p) => ({ date: p.date, value: liquidityChg.get(p.date) as number })),
    calendar,
  );
  const vixChgAlign = alignToCalendar(
    bundle.volatility.filter((p) => vixChg.has(p.date)).map((p) => ({ date: p.date, value: vixChg.get(p.date) as number })),
    calendar,
  );
  const rateChgAlign = alignToCalendar(
    bundle.rates.filter((p) => rateChg.has(p.date)).map((p) => ({ date: p.date, value: rateChg.get(p.date) as number })),
    calendar,
  );

  const buf = {
    liquidity: [] as number[],
    vixLevel: [] as number[],
    vixChg: [] as number[],
    rateChg: [] as number[],
    trendDev: [] as number[],
  };

  const out: RegimePoint[] = [];
  let regime: Regime = "neutral";

  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i];
    if (date === undefined) continue;
    const push = (arr: number[], v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) arr.push(v);
    };
    push(buf.liquidity, liqAlign[i]);
    push(buf.vixLevel, vixLevel.get(date));
    push(buf.vixChg, vixChgAlign[i]);
    push(buf.rateChg, rateChgAlign[i]);
    const px = trendAlign[i];
    const ma = smaAlign[i];
    if (px !== undefined && ma !== undefined && ma !== 0) buf.trendDev.push(px / ma - 1);

    if (i < WARMUP) continue;

    const window = <T>(arr: T[]) => arr.slice(Math.max(0, arr.length - RANK_WINDOW));
    const liqNow = buf.liquidity[buf.liquidity.length - 1];
    const rateNow = buf.rateChg[buf.rateChg.length - 1];
    if (liqNow === undefined || rateNow === undefined) continue;
    const liqScore = percentileRank(window(buf.liquidity), liqNow);
    const vixNow = vixLevel.get(date);
    const vixChgNow = vixChgAlign[i];
    if (vixNow === undefined || vixChgNow === undefined) continue;
    const volScore =
      0.7 * (1 - percentileRank(window(buf.vixLevel), vixNow)) +
      0.3 * (1 - percentileRank(window(buf.vixChg), vixChgNow));
    const rateScore = 1 - percentileRank(window(buf.rateChg), rateNow);
    const trendNow = buf.trendDev[buf.trendDev.length - 1];
    if (trendNow === undefined) continue;
    const trendScore = percentileRank(window(buf.trendDev), trendNow);

    const score =
      cfg.weights.liquidity * liqScore +
      cfg.weights.volatility * volScore +
      cfg.weights.rates * rateScore +
      cfg.weights.trend * trendScore;

    // 滞回状态机：只有明确越过阈值才切换，区间内保持——这是低换手的关键
    if (score >= cfg.scoreHigh) regime = "riskOn";
    else if (score <= cfg.scoreLow) regime = "riskOff";

    out.push({
      date,
      score,
      regime,
      equityTarget: cfg.allocation[regime],
      signals: { liquidity: liqScore, volatility: volScore, rates: rateScore, trend: trendScore },
    });
  }
  return out;
}
