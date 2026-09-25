import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// 静态输出：构建时直读 Postgres 渲染；/api/*.json 端点同时产出静态 JSON 供程序化访问。
// 上线 Cloudflare Pages 无需适配器；接入实时行情（价差监控）后再切换 hybrid + cloudflare。
export default defineConfig({
  output: "static",
  integrations: [react()],
});
