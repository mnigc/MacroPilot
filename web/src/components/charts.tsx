import { useEffect, useRef, useState } from "react";
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
    return () => {
      window.removeEventListener("resize", onResize);
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
      legend: { ...LEGEND, data: ["四引擎策略", "买入持有"] },
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
          name: "四引擎策略",
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
      ],
    },
    [props.strategy, props.benchmark, props.bands],
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
    props.short ? "chart short" : "chart",
  );
  return el;
}

const SIGNAL_META: { key: string; label: string; color: string }[] = [
  { key: "liquidity", label: "流动性", color: C.yellow },
  { key: "volatility", label: "波动率", color: C.up },
  { key: "rates", label: "利率", color: C.blue },
  { key: "trend", label: "趋势", color: C.purple },
];

export function SignalChart(props: { points: { date: string; signals: Record<string, number> }[] }) {
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
          data: props.points.map((p) => [p.date, p.signals[meta.key] ?? 0]),
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
    "chart short",
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
    "chart kline",
  );
  return el;
}

/** 分类轴下的蜡烛 + 成交量：x 用预格式化标签，缺掉的分钟因此不会在轴上留下空洞 */
function barLabel(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
}

/** 溢价的百分位刻度：0.001 → "+0.100%" */
const asPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`;

/** 七条线要能彼此分辨，但不能借用涨跌语义 —— 所以下面这组只做类别色 */
const SERIES_COLORS = ["#fcd535", "#4b9bff", "#0ecb81", "#b06bf0", "#f6465d", "#ff9f43", "#5ad2f4"];

/**
 * 日线口径的溢价历史。纵轴是"链上每股价相对美股同日收盘高出多少"，
 * 零线才是这条图的重点：零以上＝链上在抢筹，零以下＝链上折价。
 */
export function PremiumHistoryChart(props: {
  series: { ticker: string; points: { date: string; premium: number }[] }[];
}) {
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 500,
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => asPct(Number(v)) },
      legend: { ...LEGEND, data: props.series.map((s) => s.ticker) },
      grid: { left: 52, right: 20, top: 30, bottom: 60 },
      xAxis: AXIS_TIME,
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(1)}%` },
        splitLine: { lineStyle: { color: C.split } },
      },
      dataZoom: [
        {
          ...ZOOM_STYLE[0],
          /** 默认只看最近 90 天：全期极值被个别错位交易日拉到 ±10%，整条带会压成一条直线 */
          start: Math.max(0, 100 - (90 / 365) * 100),
          end: 100,
        },
      ],
      series: props.series.map((s, i) => {
        const color = SERIES_COLORS[i % SERIES_COLORS.length] ?? C.yellow;
        return {
          name: s.ticker,
          type: "line" as const,
          data: s.points.map((p) => [p.date, p.premium]),
          showSymbol: false,
          lineStyle: { color, width: 1.3 },
          itemStyle: { color },
          ...(i === 0
            ? {
                markLine: {
                  silent: true,
                  symbol: "none",
                  animation: false,
                  label: { formatter: "平价", position: "insideStartTop", color: C.text, fontSize: 10 },
                  lineStyle: { type: "dashed" as const, color: "rgba(255,255,255,0.22)", width: 1 },
                  data: [{ yAxis: 0 }],
                },
              }
            : {}),
        };
      }),
    },
    [props.series],
    "chart",
  );
  return el;
}

export interface TickBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * 最近一轮采集到的分钟蜡烛。换标的用原生 select：这张图一次只看一只，
 * 七只叠在一起只会互相盖住，而它要回答的问题本来就是"这一枚现在有多活跃"。
 */
export function TickChart(props: { bars: Record<string, TickBar[]>; order: string[] }) {
  const [ticker, setTicker] = useState(props.order[0] ?? "");
  const rows = props.bars[ticker] ?? [];
  const labels = rows.map((r) => barLabel(r.t));
  const el = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 300,
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        axisPointer: { ...TOOLTIP.axisPointer, type: "cross", label: { backgroundColor: C.panel, color: C.text2 } },
        formatter: (params: unknown) => {
          const ps = params as { axisValue: string; dataIndex: number }[];
          const i = ps[0]?.dataIndex ?? 0;
          const r = rows[i];
          if (!r) return "";
          const up = r.c >= r.o;
          const col = up ? C.up : C.down;
          return (
            `<div style="font-weight:700;margin-bottom:5px">${r ? barLabel(r.t) + " UTC" : ""}</div>` +
            `<div style="display:grid;grid-template-columns:auto auto;gap:2px 14px;font-family:var(--mono);font-size:11.5px">` +
            `<span style="color:${C.text}">开</span><span>${r.o.toFixed(3)}</span>` +
            `<span style="color:${C.text}">高</span><span>${r.h.toFixed(3)}</span>` +
            `<span style="color:${C.text}">低</span><span>${r.l.toFixed(3)}</span>` +
            `<span style="color:${C.text}">收</span><span style="color:${col}">${r.c.toFixed(3)}</span>` +
            `<span style="color:${C.text}">量</span><span>${r.v.toFixed(2)}</span></div>`
          );
        },
      },
      legend: { ...LEGEND, data: ["价格", "成交量"], right: 8, top: 2 },
      grid: { left: 56, right: 46, top: 30, bottom: 34 },
      xAxis: {
        type: "category" as const,
        data: labels,
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
          axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => v.toFixed(v < 10 ? 3 : 2) },
          splitLine: { lineStyle: { color: C.split } },
        },
        {
          type: "value",
          position: "right",
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: C.text2, fontSize: 10, formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)) },
          /** 柱子压到底部 1/3，别和蜡烛抢视线 */
          max: (v: { max: number }) => v.max * 3,
        },
      ],
      series: [
        {
          name: "价格",
          type: "candlestick" as const,
          data: rows.map((r) => [r.o, r.c, r.l, r.h]),
          barWidth: "62%",
          itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
        },
        {
          name: "成交量",
          type: "bar" as const,
          data: rows.map((r) => r.v),
          yAxisIndex: 1,
          itemStyle: { color: "rgba(75,155,255,0.30)" },
          silent: true,
        },
      ],
    },
    [ticker, props.bars, props.order],
    "chart",
  );
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 6px" }}>
        <select
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          style={{
            background: C.panel,
            color: "#eaecef",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "3px 8px",
            fontSize: 12,
            fontFamily: "var(--mono)",
          }}
        >
          {props.order.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {el}
    </div>
  );
}
