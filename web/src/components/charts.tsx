import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { REGIME_COLOR, type Band } from "../lib/bands";

export interface ChartPoint {
  date: string;
  value: number;
}

const DARK = {
  axis: "#6b7178",
  split: "rgba(38, 41, 47, 0.6)",
  text: "#9aa0a8",
};

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function markAreaFromBands(bands: Band[]): any {
  return {
    silent: true,
    data: bands.map((b) => [
      { xAxis: b.start, itemStyle: { color: REGIME_COLOR[b.regime] ?? "transparent" } },
      { xAxis: b.end },
    ]),
  };
}

export function EquityChart(props: {
  strategy: ChartPoint[];
  benchmark: ChartPoint[];
  bands: Band[];
}) {
  const ref = useChart(
    {
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", valueFormatter: (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
      legend: { data: ["四引擎策略", "买入持有"], textStyle: { color: DARK.text }, top: 0 },
      grid: { left: 64, right: 20, top: 34, bottom: 64 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: DARK.text, formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: DARK.split } },
      },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 22, bottom: 8, borderColor: "transparent", backgroundColor: "rgba(38,41,47,0.4)", fillerColor: "rgba(240,185,11,0.15)" },
      ],
      series: [
        {
          name: "四引擎策略",
          type: "line",
          data: props.strategy.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: "#f0b90b", width: 1.6 },
          itemStyle: { color: "#f0b90b" },
          markArea: markAreaFromBands(props.bands),
        },
        {
          name: "买入持有",
          type: "line",
          data: props.benchmark.map((p) => [p.date, p.value]),
          showSymbol: false,
          lineStyle: { color: "#6b7178", width: 1.2, type: "dashed" },
          itemStyle: { color: "#6b7178" },
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
      tooltip: { trigger: "axis", valueFormatter: (v) => Number(v).toFixed(3) },
      legend: { data: ["宏观综合分"], textStyle: { color: DARK.text }, top: 0 },
      grid: { left: 48, right: 20, top: 30, bottom: props.short ? 24 : 64 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLabel: { color: DARK.text },
        splitLine: { lineStyle: { color: DARK.split } },
      },
      ...(props.short ? {} : {
        dataZoom: [
          { type: "inside" },
          { type: "slider", height: 22, bottom: 8, borderColor: "transparent", backgroundColor: "rgba(38,41,47,0.4)", fillerColor: "rgba(240,185,11,0.15)" },
        ],
      }),
      series: [
        {
          name: "宏观综合分",
          type: "line",
          data: props.points.map((p) => [p.date, p.score]),
          showSymbol: false,
          lineStyle: { color: "#5b8def", width: 1.4 },
          itemStyle: { color: "#5b8def" },
          markArea: markAreaFromBands(props.bands),
          markLine: {
            silent: true,
            symbol: "none",
            label: {
              color: DARK.text,
              position: "insideEndTop",
              formatter: (p: { value: number }) => (p.value === props.scoreHigh ? "risk-on ≥" : "risk-off ≤"),
            },
            lineStyle: { type: "dashed", color: "#6b7178" },
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
      tooltip: { trigger: "axis", valueFormatter: (v) => Number(v).toFixed(2) },
      legend: { data: SIGNAL_META.map((s) => s.label), textStyle: { color: DARK.text }, top: 0 },
      grid: { left: 40, right: 20, top: 30, bottom: 24 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: DARK.axis } },
        axisLabel: { color: DARK.text },
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
        lineStyle: { color: meta.color, width: 1.3 },
        itemStyle: { color: meta.color },
      })),
    },
    [props.points],
  );
  return <div ref={ref} className="chart-box short" />;
}
