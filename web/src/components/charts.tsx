import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { REGIME_COLOR, type Band } from "../lib/bands";

export interface ChartPoint {
  date: string;
  value: number;
}

/** 与 global.css 的 :root 令牌保持同步 —— ECharts 读不了 CSS 变量，只能在此处对齐一次 */
const C = {
  text: "#5a6572",
  text2: "#848e9c",
  axis: "rgba(255,255,255,0.11)",
  split: "rgba(255,255,255,0.05)",
  panel: "#1c2028",
  border: "rgba(255,255,255,0.11)",
  yellow: "#fcd535",
  up: "#0ecb81",
  down: "#f6465d",
  blue: "#4b9bff",
  purple: "#b06bf0",
};

const TOOLTIP = {
  backgroundColor: C.panel,
  borderColor: C.border,
  borderWidth: 1,
  padding: [9, 12] as [number, number],
  textStyle: { color: "#eaecef", fontSize: 12 },
  extraCssText: "border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,.45);",
  axisPointer: { lineStyle: { color: C.border }, crossStyle: { color: C.border }, tickLength: 0 },
};

const AXIS_TIME = {
  type: "time" as const,
  axisLine: { lineStyle: { color: C.axis } },
  axisTick: { show: false },
  axisLabel: { color: C.text, hideOverlap: true, fontSize: 11 },
  splitLine: { show: false },
};

const LEGEND = {
  textStyle: { color: C.text2, fontSize: 11.5 },
  top: 2,
  itemGap: 18,
  icon: "roundRect",
  itemWidth: 13,
  itemHeight: 3,
};

/**
 * 只保留底部 slider 选区，不放 `type:'inside'`：inside 会把鼠标滚轮吃成缩放，
 * 用户在全页滚动时会被图表截住。
 */
const ZOOM_STYLE = [
  {
    type: "slider" as const,
    height: 18,
    bottom: 8,
    borderColor: "transparent",
    backgroundColor: "rgba(255,255,255,0.03)",
    fillerColor: "rgba(252,213,53,0.10)",
    handleStyle: { color: "#22272f", borderColor: "rgba(252,213,53,0.45)" },
    moveHandleStyle: { color: "#22272f" },
    dataBackground: { lineStyle: { color: C.axis }, areaStyle: { color: "rgba(255,255,255,0.03)" } },
    selectedDataBackground: { lineStyle: { color: C.yellow }, areaStyle: { color: "rgba(252,213,53,0.07)" } },
    textStyle: { color: "transparent" },
  },
];

function areaGradient(color: string, topAlpha: number): echarts.graphic.LinearGradient {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: color.replace("A", String(topAlpha)) },
    { offset: 1, color: color.replace("A", "0") },
  ]);
}

function useChart(option: echarts.EChartsOption, deps: unknown[], heightClass: string) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    /** 等高行里 .chart.grow 的容器高度由 flex 决定，窗口没动也会变，必须观测容器自身 */
    const ro = new ResizeObserver(onResize);
    ro.observe(ref.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      chartRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, deps);

  return <div ref={ref} className={heightClass} />;
}

/** markArea 必须是长度 2 的元组（起止两角），推成普通数组就会丢类型 */
export function markAreaFromBands(bands: Band[]) {
  const data = bands.map(
    (b) =>
      [
        { xAxis: b.start, itemStyle: { color: REGIME_COLOR[b.regime] ?? "transparent" } },
        { xAxis: b.end },
      ] as [{ xAxis: string; itemStyle: { color: string } }, { xAxis: string }],
  );
  return { silent: true, animation: false, data };
}

export function EquityChart(props: {
  strategy: ChartPoint[];
  benchmark: ChartPoint[];
  /** 第三条腿：60/40（60% 篮子月度再平衡 + 40% 现金计息），有数据才画 */
  benchmark6040?: ChartPoint[];
  bands: Band[];
  tall?: boolean;
}) {
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 500,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        valueFormatter: (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      },
      legend: { ...LEGEND, data: ["策略", "买入持有", ...(props.benchmark6040 ? ["60/40"] : [])] },
      grid: { left: 58, right: 20, top: 32, bottom: 60 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: C.split } },
      },
      dataZoom: ZOOM_STYLE,
      series: [
        {
          name: "策略",
          type: "line",
          data: props.strategy.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: C.yellow, width: 1.8 },
          itemStyle: { color: C.yellow },
          areaStyle: { color: areaGradient("rgba(252,213,53,A)", 0.14) },
          markArea: markAreaFromBands(props.bands),
        },
        {
          name: "买入持有",
          type: "line",
          data: props.benchmark.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: C.text2, width: 1.2, type: "dashed" },
          itemStyle: { color: C.text2 },
        },
        ...(props.benchmark6040
          ? [
              {
                name: "60/40",
                type: "line" as const,
                data: props.benchmark6040.map((p) => [p.date, p.value]),
                showSymbol: false,
                lineStyle: { color: C.purple, width: 1.2, type: "dotted" as const },
                itemStyle: { color: C.purple },
              },
            ]
          : []),
      ],
    },
    [props.strategy, props.benchmark, props.benchmark6040, props.bands],
    props.tall ? "chart tall" : "chart",
  );
  return el;
}

export function ScoreChart(props: {
  points: { date: string; score: number }[];
  bands: Band[];
  scoreHigh: number;
  scoreLow: number;
  /** 释放阈值：极态回落到 neutral 的内沿，缺省不画 */
  scoreRelease?: number;
  short?: boolean;
  /** 等高行内吃掉面板剩余高度（.chart.grow），而不是固定 240px */
  fill?: boolean;
}) {
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 500,
      animationEasing: "cubicOut",
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => Number(v).toFixed(3) },
      legend: { ...LEGEND, data: ["宏观综合分"] },
      grid: { left: 42, right: props.short ? 42 : 20, top: 28, bottom: props.short ? 22 : 60 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11 },
        splitLine: { lineStyle: { color: C.split } },
      },
      ...(props.short ? {} : { dataZoom: ZOOM_STYLE }),
      series: [
        {
          name: "宏观综合分",
          type: "line",
          data: props.points.map((p) => [p.date, p.score]),
          showSymbol: false,
          smooth: 0.12,
          lineStyle: { color: C.blue, width: 1.6 },
          itemStyle: { color: C.blue },
          areaStyle: { color: areaGradient("rgba(75,155,255,A)", 0.12) },
          markArea: markAreaFromBands(props.bands),
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { color: C.text, position: "insideEndTop", fontSize: 10, distance: 2 },
            lineStyle: { type: "dashed", color: "rgba(255,255,255,0.18)", width: 1 },
            data: [
              { yAxis: props.scoreHigh, label: { formatter: "risk-on ≥" } },
              { yAxis: props.scoreLow, label: { formatter: "risk-off ≤" } },
              ...(props.scoreRelease
                ? [
                    {
                      yAxis: props.scoreRelease,
                      lineStyle: { color: C.purple, type: "dashed" as const, width: 1 },
                      label: { formatter: "↩ 回落内沿" },
                    },
                  ]
                : []),
            ],
          },
        },
      ],
    },
    [props.points, props.bands, props.scoreHigh, props.scoreLow, props.scoreRelease],
    `chart${props.short ? " short" : ""}${props.fill ? " grow" : ""}`,
  );
  return el;
}

const SIGNAL_META: { key: string; label: string; color: string }[] = [
  { key: "liquidity", label: "流动性", color: C.yellow },
  { key: "volatility", label: "波动率", color: C.up },
  { key: "rates", label: "利率", color: C.blue },
  { key: "trend", label: "趋势", color: C.purple },
  { key: "credit", label: "信用", color: "#ff9f43" },
];

export function SignalChart(props: { points: { date: string; signals: Record<string, number> }[]; fill?: boolean }) {
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 500,
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => Number(v).toFixed(2) },
      legend: { ...LEGEND, data: SIGNAL_META.map((s) => s.label) },
      grid: { left: 38, right: 16, top: 28, bottom: 22 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11 },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: [
        ...SIGNAL_META.map((meta) => ({
          name: meta.label,
          type: "line" as const,
          data: props.points.map((p) => {
            // 老 run 缺某路信号（如 credit）时画断点而不是贴地 0 线——0 在语义上是"极度收紧"
            const v = p.signals[meta.key];
            return [p.date, v === undefined || v === null ? (null as unknown as number) : v];
          }),
          showSymbol: false,
          smooth: 0.12,
          lineStyle: { color: meta.color, width: 1.3 },
          itemStyle: { color: meta.color },
        })),
        {
          name: "占位",
          type: "line" as const,
          data: [],
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { type: "dashed" as const, color: "rgba(255,255,255,0.14)", width: 1 },
            data: [{ yAxis: 0.6 }, { yAxis: 0.4 }],
          },
        },
      ],
    },
    [props.points],
    `chart short${props.fill ? " grow" : ""}`,
  );
  return el;
}

export interface KTrade {
  date: string;
  side: "buy" | "sell";
  units: number;
  price: number;
  notional: number;
  /** 卖出时该笔的已实现盈亏（美元），买入为 null */
  realized: number | null;
  /** 该笔相对被平仓批次的收益率 */
  ret: number | null;
  driver: string;
}

/** 把体制色带边界吸附到 K 线的日期刻度上：category 轴只认存在的刻度值，否则整块 markArea 静默不画 */
function snapBands(bands: Band[], dates: string[]): Band[] {
  const at = (d: string, pick: "lo" | "hi") => {
    let idx = dates.indexOf(d);
    if (idx >= 0) return dates[idx];
    let best = 0;
    for (let i = 0; i < dates.length; i++) if (dates[i] >= d) { best = i; break; }
    if (pick === "hi" && dates[best] < d) best = dates.length - 1;
    return dates[pick === "lo" ? Math.max(0, best - 1) : best];
  };
  return bands
    .map((b) => ({ ...b, start: at(b.start, "lo"), end: at(b.end, "hi") }))
    .filter((b) => dates.indexOf(b.start) <= dates.indexOf(b.end));
}

export function KlineChart(props: {
  dates: string[];
  /** [open, close, low, high]；上游只同步了收盘价时传 null，降级为折线 */
  ohlc: [number, number, number, number][] | null;
  closes: number[];
  position: number[];
  trades: KTrade[];
  bands: Band[];
  /** 等高行内吃掉面板剩余高度，K 线永远比固定 560px 更可用 */
  fill?: boolean;
}) {
  const { dates, ohlc, closes, trades } = props;
  const idx = new Map(dates.map((d, i) => [d, i]));
  const anchor = (t: KTrade) => {
    const i = idx.get(t.date);
    const base = ohlc && i !== undefined ? (t.side === "buy" ? ohlc[i][2] : ohlc[i][3]) : closes[i ?? 0];
    return base * (t.side === "buy" ? 0.978 : 1.022);
  };
  const byDate = new Map<string, KTrade[]>();
  for (const t of trades) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);

  const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 400,
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        axisPointer: { ...TOOLTIP.axisPointer, type: "cross", label: { backgroundColor: C.panel, color: C.text2, borderColor: C.border, borderWidth: 1 } },
        formatter: (params: unknown) => {
          const ps = params as { axisValue: string; data: number[] }[];
          if (!ps.length) return "";
          const d = ps[0].axisValue;
          const i = idx.get(d);
          const rows: string[] = [`<div style="font-weight:700;margin-bottom:5px">${d}</div>`];
          if (ohlc && i !== undefined) {
            const [o, c, l, h] = ohlc[i];
            const chg = i > 0 && closes[i - 1] ? c / closes[i - 1] - 1 : 0;
            const col = chg >= 0 ? C.up : C.down;
            rows.push(
              `<div style="display:grid;grid-template-columns:auto auto;gap:2px 14px;font-family:var(--mono);font-size:11.5px">` +
                `<span style="color:${C.text}">开</span><span>${o.toFixed(2)}</span>` +
                `<span style="color:${C.text}">高</span><span>${h.toFixed(2)}</span>` +
                `<span style="color:${C.text}">低</span><span>${l.toFixed(2)}</span>` +
                `<span style="color:${C.text}">收</span><span style="color:${col}">${c.toFixed(2)} ${pct(chg)}</span></div>`,
            );
          } else if (i !== undefined) {
            rows.push(`<div style="font-family:var(--mono)">收盘 ${closes[i].toFixed(2)}</div>`);
          }
          if (i !== undefined) rows.push(`<div style="font-family:var(--mono);color:${C.text2}">持仓 ${props.position[i].toFixed(4)} 股</div>`);
          for (const t of byDate.get(d) ?? []) {
            const col = t.side === "buy" ? C.up : C.down;
            const bits = [
              `<b style="color:${col}">${t.side === "buy" ? "买入" : "卖出"}</b>`,
              `${t.units.toFixed(4)} 股 @ ${t.price.toFixed(2)}`,
              money(t.notional),
            ];
            if (t.realized !== null) bits.push(`已实现 <b style="color:${(t.realized ?? 0) >= 0 ? C.up : C.down}">${money(t.realized)}${t.ret !== null ? ` (${pct(t.ret)})` : ""}</b>`);
            else if (t.ret !== null) bits.push(`至今 <b style="color:${t.ret >= 0 ? C.up : C.down}">${pct(t.ret)}</b>`);
            rows.push(`<div style="margin-top:4px;font-family:var(--mono);font-size:11.5px">${bits.join(" · ")}</div>`);
            if (t.driver) rows.push(`<div style="color:${C.text};font-size:11px">触发引擎：${t.driver}</div>`);
          }
          return rows.join("");
        },
      },
      legend: { ...LEGEND, data: ["价格", "持仓"], right: 8, top: 2 },
      grid: { left: 56, right: 46, top: 30, bottom: 58 },
      xAxis: {
        type: "category" as const,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: C.text, fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        {
          type: "value",
          scale: true,
          position: "left",
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => v.toFixed(v < 10 ? 2 : 0) },
          splitLine: { lineStyle: { color: C.split } },
        },
        {
          type: "value",
          show: true,
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          /** 把持仓面积压到底部 1/4，别和 K 线抢视线 */
          max: (v: { max: number }) => v.max * 4,
        },
      ],
      dataZoom: [
        { ...ZOOM_STYLE[0], start: Math.max(0, 100 - (365 / Math.max(dates.length, 1)) * 100), end: 100 },
      ],
      series: [
        ohlc
          ? {
              name: "价格",
              type: "candlestick" as const,
              /** category 轴下必须只给 [open, close, low, high]，带上日期会被当成第五维而整根不画 */
              data: ohlc.map((v) => [...v]),
              barWidth: "68%",
              itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
              markArea: markAreaFromBands(snapBands(props.bands, dates)),
              markPoint: {
                silent: true,
                animation: false,
                symbolSize: 8,
                label: { show: false },
                data: trades.map((t) => ({
                  coord: [t.date, anchor(t)] as [string, number],
                  /** ECharts 的 markPoint 项把 name 当必填，虽然 label 已经关掉 */
                  name: `${t.side}-${t.date}`,
                  symbol: "triangle" as const,
                  symbolRotate: t.side === "buy" ? 0 : 180,
                  symbolOffset: [0, t.side === "buy" ? 5 : -5],
                  itemStyle: { color: t.side === "buy" ? C.up : C.down, opacity: 0.9 },
                })),
              },
            }
          : {
              name: "价格",
              type: "line" as const,
              data: closes,
              showSymbol: false,
              lineStyle: { color: C.yellow, width: 1.6 },
              itemStyle: { color: C.yellow },
              areaStyle: { color: areaGradient("rgba(252,213,53,A)", 0.1) },
              markArea: markAreaFromBands(snapBands(props.bands, dates)),
              markPoint: {
                silent: true,
                animation: false,
                symbolSize: 8,
                label: { show: false },
                data: trades.map((t) => ({
                  coord: [t.date, anchor(t)] as [string, number],
                  /** ECharts 的 markPoint 项把 name 当必填，虽然 label 已经关掉 */
                  name: `${t.side}-${t.date}`,
                  symbol: "triangle" as const,
                  symbolRotate: t.side === "buy" ? 0 : 180,
                  itemStyle: { color: t.side === "buy" ? C.up : C.down, opacity: 0.9 },
                })),
              },
            },
        {
          name: "持仓",
          type: "line" as const,
          data: props.position,
          yAxisIndex: 1,
          showSymbol: false,
          step: "end" as const,
          lineStyle: { color: C.blue, width: 1, opacity: 0.5 },
          areaStyle: { color: "rgba(75,155,255,0.13)" },
          silent: true,
        },
      ],
    },
    [dates, ohlc, closes, props.position, trades, props.bands],
    `chart kline${props.fill ? " grow" : ""}`,
  );
  return el;
}

/** 蒙特卡洛前景扇形：p5–p95 外带 + p25–p75 内带 + 中位线。纵轴是"起始净值 = 1"的倍数 */
export function FanChart(props: {
  horizons: number[];
  p5: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
}) {
  const axis = props.horizons.map((h) => `${h}d`);
  const band = (lo: number[], hi: number[], color: string, name: string) => {
    // ECharts 无原生置信带：stack 基线 + 差值层，基线透明
    return [
      {
        name: `${name}-base`,
        type: "line" as const,
        data: lo,
        stack: name,
        lineStyle: { opacity: 0 },
        symbol: "none",
        silent: true,
        tooltip: { show: false },
      },
      {
        name,
        type: "line" as const,
        data: hi.map((v, i) => Math.max(0, v - (lo[i] as number))),
        stack: name,
        lineStyle: { opacity: 0 },
        areaStyle: { color, silent: true },
        symbol: "none",
        silent: true,
        tooltip: { show: false },
      },
    ];
  };
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 400,
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => `${(Number(v) * 100).toFixed(1)}%` },
      legend: { ...LEGEND, data: ["中位数", "p25–p75", "p5–p95"] },
      grid: { left: 46, right: 16, top: 28, bottom: 22 },
      xAxis: { type: "category" as const, data: axis, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false }, axisLabel: { color: C.text, fontSize: 10.5 } },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: [
        ...band(props.p5, props.p95, "rgba(252,213,53,0.10)", "p5-p95"),
        ...band(props.p25, props.p75, "rgba(252,213,53,0.16)", "p25-p75"),
        {
          name: "中位数",
          type: "line" as const,
          data: props.p50,
          showSymbol: false,
          lineStyle: { color: C.yellow, width: 2 },
          itemStyle: { color: C.yellow },
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { type: "dashed" as const, color: "rgba(255,255,255,0.16)", width: 1 },
            data: [{ yAxis: 1 }],
          },
        },
      ],
    },
    [props.horizons, props.p5, props.p25, props.p50, props.p75, props.p95],
    "chart short",
  );
  return el;
}

/** 滚动 12 个月夏普：策略 vs 基准，零线以下说明"过去一年还在亏风险调整后收益" */
export function RollingChart(props: {
  strategy: { date: string; value: number }[];
  benchmark: { date: string; value: number }[];
}) {
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 400,
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => Number(v).toFixed(2) },
      legend: { ...LEGEND, data: ["策略", "买入持有"] },
      grid: { left: 40, right: 16, top: 28, bottom: 22 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11 },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: [
        {
          name: "策略",
          type: "line",
          data: props.strategy.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: C.yellow, width: 1.5 },
          itemStyle: { color: C.yellow },
        },
        {
          name: "买入持有",
          type: "line",
          data: props.benchmark.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: C.text2, width: 1.1, type: "dashed" },
          itemStyle: { color: C.text2 },
        },
        {
          name: "零线",
          type: "line" as const,
          data: [],
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { type: "dashed" as const, color: "rgba(246,70,93,0.35)", width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    },
    [props.strategy, props.benchmark],
    "chart short",
  );
  return el;
}

/** 账本净值对比（实盘部署页）：实盘 / 影子 / 纸面三条线，没数据的账本由调用方过滤掉不传 */
export function LedgerChart(props: {
  series: { name: string; points: ChartPoint[]; color?: string; dashed?: boolean }[];
}) {
  const fallback = [C.yellow, C.blue, C.text2];
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 500,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        valueFormatter: (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      },
      legend: { ...LEGEND, data: props.series.map((s) => s.name) },
      grid: { left: 58, right: 20, top: 32, bottom: 60 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: C.split } },
      },
      dataZoom: ZOOM_STYLE,
      series: props.series.map((s, i) => ({
        name: s.name,
        type: "line" as const,
        data: s.points.map((p) => [p.date, p.value]),
        showSymbol: false,
        lineStyle: {
          color: s.color ?? fallback[i],
          width: i === 0 ? 1.8 : 1.2,
          type: s.dashed ? ("dashed" as const) : ("solid" as const),
        },
        itemStyle: { color: s.color ?? fallback[i] },
        ...(i === 0 ? { areaStyle: { color: areaGradient("rgba(252,213,53,A)", 0.12) } } : {}),
      })),
    },
    [props.series],
    "chart",
  );
  return el;
}
