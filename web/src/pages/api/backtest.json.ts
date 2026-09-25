import type { APIRoute } from "astro";
import { getLatestRun } from "../../lib/db";

export const prerender = true;

/** 静态产出 /api/backtest.json：最新回测的指标、参数与净值曲线 */
export const GET: APIRoute = async () => {
  const run = await getLatestRun();
  return new Response(JSON.stringify(run, (_, v) => (typeof v === "bigint" ? Number(v) : v)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
