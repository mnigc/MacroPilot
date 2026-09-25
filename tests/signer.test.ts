import { describe, expect, it } from "vitest";
import { authHeaders, buildPreHash, signRequest, utcTimestamp } from "../src/binance/signer.js";
import { encodeQuery } from "../src/binance/client.js";

describe("签名构造", () => {
  const secret = "test-secret";

  it("preHash = timestamp + METHOD + path + body 直接拼接", () => {
    expect(buildPreHash("2026-05-11T10:08:57.715Z", "get", "/build/api/v1/x?y=1", "B")).toBe(
      "2026-05-11T10:08:57.715ZGET/build/api/v1/x?y=1B",
    );
  });

  it("query 保持原始 URL 编码（空格为 %20），供签名与发送共用", () => {
    expect(encodeQuery({ keyword: "APPLE USD", chainId: 56 })).toBe("?keyword=APPLE%20USD&chainId=56");
  });

  it("签名为 Base64(HMAC-SHA256)，且任一成分变化都会改变签名", () => {
    const s1 = signRequest(secret, buildPreHash("t1", "GET", "/a", ""));
    const s2 = signRequest(secret, buildPreHash("t2", "GET", "/a", ""));
    const s3 = signRequest(secret, buildPreHash("t1", "POST", "/a", ""));
    const s4 = signRequest(secret, buildPreHash("t1", "GET", "/b", ""));
    for (const s of [s1, s2, s3, s4]) {
      expect(s).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(new Set([s1, s2, s3, s4]).size).toBe(4);
  });

  it("authHeaders 产出四个必需头，时间戳为 ISO 8601 毫秒格式", () => {
    const h = authHeaders("key", secret, "GET", "/build/api/v1/dex/market/rwa/tokens");
    expect(h["X-OC-APIKEY"]).toBe("key");
    expect(h["X-OC-TIMESTAMP"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(h["X-OC-RECV-WINDOW"]).toBe("5000");
    // 同一 requestPath + 同一时间戳应产生可复现签名
    const fixed = new Date("2026-09-26T00:00:00Z");
    const a = authHeaders("key", secret, "GET", "/build/api/v1/dex/market/rwa/tokens", "", 5000, fixed);
    const b = authHeaders("key", secret, "GET", "/build/api/v1/dex/market/rwa/tokens", "", 5000, fixed);
    expect(b["X-OC-SIGN"]).toBe(a["X-OC-SIGN"]);
    expect(a["X-OC-TIMESTAMP"]).toBe("2026-09-26T00:00:00.000Z");
  });

  it("utcTimestamp 输出毫秒精度", () => {
    expect(utcTimestamp(new Date("2026-09-26T00:00:00Z"))).toBe("2026-09-26T00:00:00.000Z");
  });
});
