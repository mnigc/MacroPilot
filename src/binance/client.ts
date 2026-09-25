import { authHeaders } from "./signer.js";

export const BASE_URL = "https://web3.binance.com/build";

/** 统一响应信封：{ code, msg, data, timestamp, success }，code=0 表示成功 */
export interface OCResult<T> {
  code: number;
  msg: string;
  data: T;
  timestamp: number;
  success: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`币安 Web3 API 错误 ${code}: ${message}`);
    this.name = "ApiError";
  }
}

export interface RateLimitOptions {
  /** 触发 429 时最多重试次数（带 Retry-After 退避） */
  maxRetries?: number;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BinanceWeb3Client {
  constructor(
    private readonly apiKey: string,
    private readonly secretKey: string,
    private readonly limits: RateLimitOptions = {},
  ) {}

  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  post<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, json);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | undefined>,
    json?: unknown,
    attempt = 0,
  ): Promise<T> {
    const query = encodeQuery(params);
    // requestPath 参与签名：/build 前缀 + 原始编码 query，与实际发送的完全一致
    const requestPath = `${BASE_URL}${path}${query}`;
    const body = json === undefined ? "" : JSON.stringify(json);
    const headers: Record<string, string> = {
      ...authHeaders(this.apiKey, this.secretKey, method, requestPath, body),
    };
    if (body) headers["Content-Type"] = "application/json";

    const timeoutMs = this.limits.timeoutMs ?? 15_000;
    const res = await fetch(requestPath, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "2");
      const maxRetries = this.limits.maxRetries ?? 2;
      if (attempt < maxRetries) {
        await sleep(retryAfter * 1000);
        return this.request<T>(method, path, params, json, attempt + 1);
      }
      throw new ApiError(42900, `请求频率超限，Retry-After=${retryAfter}s`, 429, retryAfter);
    }

    if (!res.ok) {
      // 401/403 等网关层错误可能不返回标准信封
      const text = await res.text().catch(() => "");
      let code: number | string = res.status;
      let msg = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as Partial<OCResult<unknown>>;
        if (parsed.code !== undefined) code = parsed.code;
        if (parsed.msg) msg = parsed.msg;
      } catch {
        /* 保留原始文本 */
      }
      throw new ApiError(code, msg, res.status);
    }

    const payload = (await res.json()) as OCResult<T>;
    if (payload.code !== 0) {
      throw new ApiError(payload.code, payload.msg, res.status);
    }
    return payload.data;
  }
}

/** 手工百分号编码（空格编码为 %20 而非 +，与文档签名示例一致） */
export function encodeQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
