import { alignToCalendar, changeAbs, changeOver, percentileRank, sma, type Point } from "../data/stats.js";

/** 体制三态：risk-on 全仓 / neutral 中性 / risk-off 防御 */
export type Regime = "riskOn" | "neutral" | "riskOff";

export interface MacroBundle {
  liquidity: Point[]; // WALCL，周频
  volatility: Point[]; // VIX，日频
  rates: Point[]; // DGS10，日频
  trend: Point[]; // SP500，日频（兼作主日历）
  /** 高收益信用利差（BAMLH0A0HYM2，日频）。缺失时信用信号按中性 0.5 处理并按可用信号重归一 */
  credit?: Point[];
  /** 失业率（UNRATE，月频）。缺失时 Sahm 确认门不生效 */
  labor?: Point[];
  /** 3 个月期国库券（DGS3MO，日频）——现金筒计息，不是信号 */
  cash?: Point[];
}

export interface SignalWeights {
  liquidity: number;
  volatility: number;
  rates: number;
  trend: number;
  /** 信用利差；未提供 credit 序列时该项被剔除并重归一 */
  credit?: number;
}

export interface RegimeConfig {
  weights: SignalWeights;
  /** 综合分 ≥ scoreHigh → risk-on；≤ scoreLow → risk-off */
  scoreHigh: number;
  scoreLow: number;
  /**
   * 释放阈值（中性态的入口）：处于 risk-on 时跌破 scoreRelease 才降为 neutral，
   * 处于 risk-off 时升破 scoreRelease 才升为 neutral。缺省取两阈值的中点。
   * 没有这一条，滞回就只有"进入极态"的边沿、没有"离开极态"的边沿——
   * neutral 会退化成仅初始值、一旦离开便永久不可达（本项目 D1 实测 0 天）。
   */
  scoreRelease?: number;
  /** risk-on/neutral/risk-off 对应的目标股票仓位 */
  allocation: Record<Regime, number>;
  /**
   * Sahm 确认门（可选）：Sahm 规则读数（失业率 3 个月均值 − 12 个月低点）达到阈值
   * （经典 0.50pp）时，无论综合分多高，权益仓位上限压回 risk-off 档。
   * 它不做加权投票——劳动力数据的角色是"衰退确认"，与恐慌/流动性那类"变化信号"时序不同，
   * 加权投票会把确认信号稀释掉。
   */
  gate?: { sahmThreshold: number };
}

export interface SignalScores {
  liquidity: number;
  volatility: number;
  rates: number;
  trend: number;
  credit: number;
}

export interface RegimePoint {
  date: string;
  score: number;
  regime: Regime;
  /** 体制档位的目标仓位 × Sahm 门下限（不含波动率/估值叠加，那两层在 overlays 里） */
  equityTarget: number;
  signals: SignalScores;
  /** Sahm 规则读数（pp）；无失业率序列时为 null */
  sahm: number | null;
  /** Sahm 门是否在本日生效（生效时 equityTarget 被托底到 risk-off 档） */
  gateActive: boolean;
}

// 观察窗口（交易日）：
const RANK_WINDOW = 756; // 百分位回看 3 年
const CHANGE_LAG = 65; // 变化窗口 ≈ 13 周
const VOL_TREND_LAG = 20; // VIX 短趋势 ≈ 1 个月
const SMA_WINDOW = 200; // 长趋势均线
export const WARMUP_DAYS = RANK_WINDOW + CHANGE_LAG + 1; // 第一个可用信号日

/**
 * 三态滞回（Schmitt 触发）单步：进入极态要越过外沿，回到中性要越过内沿 release。
 * 独立成函数是因为这条规则本身出过 bug——只写"进入极态"边沿时 neutral 一旦离开
 * 便永久不可达（实测 0 天），因此必须可被单测钉住。
 */
export function nextRegime(
  score: number,
  prev: Regime,
  cfg: Pick<RegimeConfig, "scoreHigh" | "scoreLow" | "scoreRelease">,
): Regime {
  const release = cfg.scoreRelease ?? (cfg.scoreHigh + cfg.scoreLow) / 2;
  if (score >= cfg.scoreHigh) return "riskOn";
  if (score <= cfg.scoreLow) return "riskOff";
  if (prev === "riskOn" && score < release) return "neutral";
  if (prev === "riskOff" && score > release) return "neutral";
  return prev;
}

/**
 * Sahm 规则（Claudia Sahm, 2019）：失业率 3 个月均值 − 过去 12 个月最低值 ≥ 0.5pp
 * 即判定衰退开始。输入为月频 UNRATE（date 为当月 1 号）；对齐靠 step-carry，
 * 所以这里的"月"按序列位置数而非日历日——12 个位置 = 12 个月。
 * 返回当前读数（pp）；历史不足 13 个月时返回 null。
 */
export function sahmRule(unrate: Point[]): number | null {
  if (unrate.length < 13) return null;
  const window = unrate.slice(-13);
  const avg3 = window.slice(-3).reduce((a, p) => a + p.value, 0) / 3;
  const low12 = Math.min(...window.slice(0, 12).map((p) => p.value));
  return avg3 - low12;
}

/**
 * 体制时间线：每个交易日输出综合分与目标仓位。
 *
 * 五路信号全部归一为 [0,1]（分数越高越偏 risk-on）：
 *   liquidity  联储资产负债表 13 周变化的 3 年百分位（放水=高分）
 *   volatility VIX 水平（70%）+ 1 个月趋势（30%）的双百分位（恐慌=低分）
 *   rates      10Y 收益率 13 周变化的反向百分位（利率下行=高分）
 *   trend      标普相对 200 日均线偏离的百分位（强势=高分）
 *   credit     高收益利差水平（70%）+ 13 周变化（30%）的反向百分位（信用收紧=低分）
 *
 * 权重按**实际可用的信号**重归一：某路序列缺失时该信号记 0.5（中性）并退出加权，
 * 其余按配置权重占比放大——这样新增信号不会因为一次数据断供就把综合分整体拉偏。
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

  const align = (series: Point[], chg: Map<string, number>) =>
    alignToCalendar(
      series.filter((p) => chg.has(p.date)).map((p) => ({ date: p.date, value: chg.get(p.date) as number })),
      calendar,
    );
  const liqAlign = align(bundle.liquidity, liquidityChg);
  const vixChgAlign = align(bundle.volatility, vixChg);
  const rateChgAlign = align(bundle.rates, rateChg);

  // 信用利差：水平与 13 周变化双百分位，与波动率信号同构（70/30）
  const creditLevel = new Map((bundle.credit ?? []).map((p) => [p.date, p.value]));
  const creditChg = changeAbs(bundle.credit ?? [], CHANGE_LAG);
  const creditChgAlign = align(bundle.credit ?? [], creditChg);
  // 失业率：月频 step-carry 到交易日，再算 Sahm 读数
  const laborAlign = bundle.labor ? alignToCalendar(bundle.labor, calendar) : [];

  // 权重重归一：只统计有序列数据的信号。credit 序列缺失时退出加权而非记 0 分，
  // 否则综合分会整体下移一个权重档，阈值语义全变。
  const hasCredit = (bundle.credit?.length ?? 0) > 0;
  const w = cfg.weights;
  const weightSum =
    w.liquidity + w.volatility + w.rates + w.trend + (hasCredit ? (w.credit ?? 0) : 0);
  const norm = (x: number) => (weightSum > 0 ? x / weightSum : 0);

  const buf = {
    liquidity: [] as number[],
    vixLevel: [] as number[],
    vixChg: [] as number[],
    rateChg: [] as number[],
    trendDev: [] as number[],
    creditLevel: [] as number[],
    creditChg: [] as number[],
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
    push(buf.creditLevel, creditLevel.get(date));
    push(buf.creditChg, creditChgAlign[i]);

    if (i < WARMUP_DAYS) continue;

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
    const creditNowL = buf.creditLevel[buf.creditLevel.length - 1];
    const creditNowC = buf.creditChg[buf.creditChg.length - 1];
    const creditScore =
      hasCredit && creditNowL !== undefined && creditNowC !== undefined
        ? 0.7 * (1 - percentileRank(window(buf.creditLevel), creditNowL)) +
          0.3 * (1 - percentileRank(window(buf.creditChg), creditNowC))
        : 0.5;

    const score =
      norm(w.liquidity) * liqScore +
      norm(w.volatility) * volScore +
      norm(w.rates) * rateScore +
      norm(w.trend) * trendScore +
      (hasCredit ? norm(w.credit ?? 0) * creditScore : 0);

    regime = nextRegime(score, regime, cfg);

    // Sahm 确认门：读数用"截至当日的可用观测"（step-carry 后按序列尾部计算）
    let sahm: number | null = null;
    let gateActive = false;
    if (bundle.labor && bundle.labor.length) {
      const obs = bundle.labor.filter((p) => p.date <= date);
      sahm = sahmRule(obs);
      gateActive = sahm !== null && sahm >= (cfg.gate?.sahmThreshold ?? 0.5);
    }

    out.push({
      date,
      score,
      regime,
      equityTarget: gateActive ? Math.min(cfg.allocation[regime], cfg.allocation.riskOff) : cfg.allocation[regime],
      signals: { liquidity: liqScore, volatility: volScore, rates: rateScore, trend: trendScore, credit: creditScore },
      sahm,
      gateActive,
    });
  }
  return out;
}
