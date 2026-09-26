import { describe, expect, it } from "vitest";
import { extractTypedData, impactPercent, pickQuote } from "../src/exec/live.js";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { joinDrivers, splitDrivers } from "../src/strategy/drivers.js";

/** Anvil 测试账户 #0 的公知私钥，仅用于离线签名验证，不指向任何真实资金 */
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

describe("RFQ EIP-712 签名链路", () => {
  it("归一化 swap 响应载荷，并剔除 viem 不接受的 EIP712Domain", () => {
    const typed = extractTypedData({
      typedDataToSign: {
        domain: { name: "Binance", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000001" },
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Order: [
            { name: " makerAmount", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Order",
        message: { makerAmount: "1000", deadline: "2000" },
      },
    });
    expect(Object.keys(typed.types)).toEqual(["Order"]);
    expect(typed.primaryType).toBe("Order");
  });

  it("单一 type 时自动推断 primaryType；载荷缺字段即抛错", () => {
    const typed = extractTypedData({
      domain: { name: "X", chainId: 56 },
      types: { Swap: [{ name: "id", type: "bytes32" }] },
      message: { id: "0x00" },
    });
    expect(typed.primaryType).toBe("Swap");
    expect(() => extractTypedData({ types: {} })).toThrow(/缺少 EIP-712 载荷/);
  });

  it("本地私钥签出的 typedData 可被验签回同一地址（私钥不出机器）", async () => {
    const account = privateKeyToAccount(TEST_PK);
    const { domain, types, message, primaryType } = extractTypedData({
      typedDataToSign: {
        domain: { name: "Binance RWA", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000001" },
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Order: [
            { name: "makerAmount", type: "uint256" },
            { name: "takerAmount", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        message: { makerAmount: "1000000000000000000", takerAmount: "4210000000000000000", deadline: "2000000000" },
      },
    });
    const signature = await account.signTypedData({ domain, types, primaryType, message } as never);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(
      verifyTypedData({
        address: account.address,
        domain,
        types,
        primaryType,
        message,
        signature,
      } as never),
    ).resolves.toBe(true);
  });
});

describe("报价选单", () => {
  it("优先冲击成本最小的路由，全为空报价时抛错", () => {
    const best = pickQuote([
      { quoteId: "a", fromTokenAmount: "50", toTokenAmount: "5", priceImpactPercent: "0.0080" },
      { quoteId: "b", fromTokenAmount: "50", toTokenAmount: "4", priceImpactPercent: "0.0020" },
    ]);
    expect(best.quoteId).toBe("b");
    expect(() => pickQuote([{ quoteId: "", toTokenAmount: undefined }])).toThrow(/无可用/);
  });

  it("priceImpactPercent 是小数字符串，护栏要按百分比放大后比较", () => {
    // 实测 50 USDT 买 NVDAon 返回 "0.0009363173"，即 0.0936%；当成百分数会让 1% 阈值形同虚设
    const route = { quoteId: "x", fromTokenAmount: "1", toTokenAmount: "1", priceImpactPercent: "0.0009363173" };
    expect(impactPercent(route)).toBeCloseTo(0.0936, 3);
    expect(impactPercent({ quoteId: "y" })).toBe(0);
  });
});

describe("交易驱动归因", () => {
  it("按固定顺序拼接、可无损拆回", () => {
    expect(joinDrivers(["drift", "dca", "seed"])).toBe("seed,dca,drift");
    expect(splitDrivers("dca,regime,drift")).toEqual(["dca", "regime", "drift"]);
    expect(splitDrivers("bogus,dca")).toEqual(["dca"]);
  });

  it("驱动串可被 LIKE '%dca%' 精确筛出（定投幂等去重依赖此性质）", () => {
    const others = ["seed", "regime", "drift", "earnings"].map((d) => joinDrivers([d as never]));
    for (const r of others) expect(r).not.toContain("dca");
    expect(joinDrivers(["dca", "drift"])).toContain("dca");
  });
});
