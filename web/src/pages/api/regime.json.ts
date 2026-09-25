import type { APIRoute } from "astro";
import { getLatestRun, getRegimePoints } from "../../lib/db";

export const prerender = true;

/** 静态产出 /api/regime.json：逐日宏观体制时间线（综合分/体制/目标仓位/信号分量） */
export const GET: APIRoute = async () => {
  const run = await getLatestRun();
  if (!run) return new Response(JSON.stringify({ error: "no run" }), { status: 404 });
  const points = await getRegimePoints(run.id);
  return new Response(JSON.stringify({ runId: run.id, points }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
