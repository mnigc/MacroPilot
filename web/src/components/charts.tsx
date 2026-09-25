import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { REGIME_COLOR, type Band } from "../lib/bands";

export interface ChartPoint {
  date: string;
  value: number;
}

const DARK = {
  axis: "#3a4149",
  split: "rgba(255,255,255,0.045)",
  text: "#7d8590",
  tooltipBg: "rgba(17,20,26,0.96)",
  tooltipBorder: "rgba(255,255,255,0.1)",
};

const TOOLTIP = {
  backgroundColor: DARK.tooltipBg,
  borderColor: DARK.tooltipBorder,
  borderWidth: 1,
  padding: [10, 14],
  textStyle: { color: "#e8ebf0", fontSize: 12.5 },
  extraCssText: "border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.5); backdrop-filter: blur(6px);",
};

function areaGradient(color: string, topAlpha = 0.22): echarts.graphic.LinearGradient {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: color.replace("ALPHA", String(topAlpha)) },
    { offset: 1, color: color.replace("ALPHA", "0") },
  ]);
}

function useChart(option: echarts.EChartsOption, deps: unknown[]) {
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

  return ref;
}

export function markAreaFromBands(bands: Band[]): unknown {
  return {
    silent: true,
    animation: false,
    data: bands.map((b) => [
      { xAxis: b.start, itemStyle: { color: REGIME_COLOR[b.regime] ?? "transparent" } },
      { xAxis: b.end },
    ]),
  };
}

const ZOOM_STYLE = [
  { type: "inside" as const },
  {
    type: "slider" as const,
    height: 20,
    bottom: 10,
    borderColor: "transparent",
    backgroundColor: "rgba(255,255,255,0.04)",
    fillerColor: "rgba(240,185,11,0.12)",
    handleStyle: { color: "#2a2f38", borderColor: "rgba(240,185,11,0.5)" },
    moveHandleStyle: { color: "#2a2f38" },
    dataBackground: { lineStyle: { color: "#3a4149" }, areaStyle: { color: "rgba(255,255,255,0.03)" } },
    selectedDataBackground: { lineStyle: { color: "#f0b90b" }, areaStyle: { color: "rgba(240,185,11,0.08)" } },
    textStyle: { color: "transparent" },
  },
];

export function EquityChart(props: {
  strategy: ChartPoint[];
  benchmark: ChartPoint[];
  bands: Band[];
}) {
  const ref = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 1200,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        valueFormatter: (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      },
      legend: {
        data: ["四引擎策略", "买入持有"],
        textStyle: { color: DARK.text, fontSize: 12 },
        top: 4,
        itemGap: 22,
        icon: "roundRect",
        itemWidth: 14,
        itemHeight: 3,
      },
      grid: { left: 62, right: 22, top: 38, bottom: 66 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text, hideOverlap: true },
        splitLine: { show: false },
        axisPointer: { lineStyle: { color: "rgba(255,255,255,0.18)" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: DARK.text, formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: DARK.split } },
      },
      dataZoom: ZOOM_STYLE,
      series: [
        {
          name: "四引擎策略",
          type: "line",
          data: props.strategy.map((p) => [p.date, p.value]),
          showSymbol: false,
          smooth: 0.15,
          lineStyle: {
            color: "#f0b90b",
            width: 2,
            shadowColor: "rgba(240,185,11,0.45)",
            shadowBlur: 12,
            shadowOffsetY: 4,
          },
          itemStyle: { color: "#f0b90b" },
          areaStyle: { color: areaGradient("rgba(240,185,11,ALPHA)", 0.16) },
          markArea: markAreaFromBands(props.bands),
        },
        {
          name: "买入持有",
          type: "line",
          data: props.benchmark.map((p) => [p.date, p.value]),
          showSymbol: false,
          smooth: 0.15,
          lineStyle: { color: "#565d68", width: 1.3, type: "dashed" },
          itemStyle: { color: "#565d68" },
        },
      ],
    },
    [props.strategy, props.benchmark, props.bands],
  );
  return <div ref={ref} className="chart-box" />;
}

export function ScoreChart(props: {
  points: { date: string; score: number }[];
  bands: Band[];
  scoreHigh: number;
  scoreLow: number;
  short?: boolean;
}) {
  const ref = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 1100,
      animationEasing: "cubicOut",
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => Number(v).toFixed(3) },
      legend: {
        data: ["宏观综合分"],
        textStyle: { color: DARK.text, fontSize: 12 },
        top: 4,
        icon: "roundRect",
        itemWidth: 14,
        itemHeight: 3,
      },
      grid: { left: 46, right: props.short ? 46 : 22, top: 32, bottom: props.short ? 24 : 66 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text, hideOverlap: true },
        splitLine: { show: false },
        axisPointer: { lineStyle: { color: "rgba(255,255,255,0.18)" } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLabel: { color: DARK.text },
        splitLine: { lineStyle: { color: DARK.split } },
      },
      ...(props.short ? {} : { dataZoom: ZOOM_STYLE }),
      series: [
        {
          name: "宏观综合分",
          type: "line",
          data: props.points.map((p) => [p.date, p.score]),
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { color: "#5b8def", width: 1.8, shadowColor: "rgba(91,141,239,0.4)", shadowBlur: 10, shadowOffsetY: 3 },
          itemStyle: { color: "#5b8def" },
          areaStyle: { color: areaGradient("rgba(91,141,239,ALPHA)", 0.14) },
          markArea: markAreaFromBands(props.bands),
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: {
              color: "#7d8590",
              position: "insideEndTop",
              fontSize: 10.5,
              formatter: (p: { value: number }) => (p.value === props.scoreHigh ? "risk-on ≥" : "risk-off ≤"),
            },
            lineStyle: { type: "dashed", color: "#4a525c" },
            data: [{ yAxis: props.scoreHigh }, { yAxis: props.scoreLow }],
          },
        },
      ],
    },
    [props.points, props.bands, props.scoreHigh, props.scoreLow],
  );
  return <div ref={ref} className={props.short ? "chart-box short" : "chart-box"} />;
}

const SIGNAL_META: { key: string; label: string; color: string }[] = [
  { key: "liquidity", label: "流动性", color: "#f0b90b" },
  { key: "volatility", label: "波动率", color: "#2ebd85" },
  { key: "rates", label: "利率", color: "#5b8def" },
  { key: "trend", label: "趋势", color: "#b56ef0" },
];

export function SignalChart(props: {
  points: { date: string; signals: Record<string, number> }[];
}) {
  const ref = useChart(
    {
      backgroundColor: "transparent",
      animationDuration: 1100,
      tooltip: { trigger: "axis", ...TOOLTIP, valueFormatter: (v) => Number(v).toFixed(2) },
      legend: {
        data: SIGNAL_META.map((s) => s.label),
        textStyle: { color: DARK.text, fontSize: 12 },
        top: 4,
        itemGap: 18,
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 3,
      },
      grid: { left: 40, right: 16, top: 32, bottom: 24 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLabel: { color: DARK.text },
        splitLine: { lineStyle: { color: DARK.split } },
      },
      series: SIGNAL_META.map((meta) => ({
        name: meta.label,
        type: "line",
        data: props.points.map((p) => [p.date, p.signals[meta.key] ?? 0]),
        showSymbol: false,
        smooth: 0.2,
        lineStyle: { color: meta.color, width: 1.5 },
        itemStyle: { color: meta.color },
      })),
    },
    [props.points],
  );
  return <div ref={ref} className="chart-box short" />;
}
