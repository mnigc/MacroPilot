import { createHmac } from "node:crypto";

/**
 * 请求签名（对照官方 Authentication 文档实现）：
 *   preHash  = timestamp + HTTP方法 + requestPath + body   （四段直接拼接，无分隔符）
 *   签名     = Base64( HMAC-SHA256( SecretKey, preHash ) )
 *
 * requestPath 必须带 /build 网关前缀，且 query 保持线上发送的原始 URL 编码形式——
 * 官方文档明确把"漏掉 /build"列为签名失败（40102）的头号原因。
 */
export function buildPreHash(timestamp: string, method: string, requestPath: string, body = ""): string {
  return `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
}

export function signRequest(secretKey: string, preHash: string): string {
  return createHmac("sha256", secretKey).update(preHash, "utf8").digest("base64");
}

/** ISO 8601 毫秒精度 UTC 时间，如 2026-05-11T10:08:57.715Z */
export function utcTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export interface AuthHeaders {
  "X-OC-APIKEY": string;
  "X-OC-TIMESTAMP": string;
  "X-OC-SIGN": string;
  "X-OC-RECV-WINDOW": string;
}

export function authHeaders(
  apiKey: string,
  secretKey: string,
  method: string,
  requestPath: string,
  body = "",
  recvWindowMs = 5000,
  now: Date = new Date(),
): AuthHeaders {
  const timestamp = utcTimestamp(now);
  return {
    "X-OC-APIKEY": apiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": signRequest(secretKey, buildPreHash(timestamp, method, requestPath, body)),
    "X-OC-RECV-WINDOW": String(recvWindowMs),
  };
}
