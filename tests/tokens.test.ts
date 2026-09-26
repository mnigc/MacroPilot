import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AggregatorApi } from "../src/binance/aggregator.js";
import type { RwaApi, RwaToken } from "../src/binance/rwa.js";
import { candidatesOf, resolveTokens } from "../src/binance/tokens.js";

/** 2026-09-26 实测的 MSFT 场景：ondo 那枚链上无盘口，bstock 那枚可正常成交 */
const MSFT_ONDO: RwaToken = {
  underlyingTicker: "MSFT",
  binanceChainId: "56",
  platformId: "ondo",
  tokenSymbol: "MSFTon",
  tokenContractAddress: "0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3",
  decimals: "18",
  tokenToShareRatio: "1.005731",
  volume24H: "19764744926.08",
};
const MSFT_BSTOCK: RwaToken = {
  ...MSFT_ONDO,
  platformId: "bstock",
  tokenSymbol: "MSFTB",
  tokenContractAddress: "0x80106cb3ead06659a5ad19df39d9b4733863b9b0",
  volume24H: "17362877095",
};
const LIST: RwaToken[] = [
  MSFT_ONDO,
  MSFT_BSTOCK,
  { ...MSFT_ONDO, binanceChainId: "1" }, // 别的链，不该进来
  { ...MSFT_ONDO, underlyingTicker: "MSFTX" }, // 同前缀不同标的，不该进来
];

const rwaStub = { listTokens: async () => LIST } as unknown as RwaApi;

function aggStub(impactByAddress: Record<string, string>): AggregatorApi {
  return {
    quote: async (params: { toTokenAddress: string }) => {
      const impact = impactByAddress[params.toTokenAddress];
      if (impact === undefined) throw new Error("no route");
      const perToken = 519.6;
      return [
        {
          quoteId: "q",
          vendorName: "LiquidMesh",
          executionMode: "SWAP",
          fromTokenAmount: "50000000000000000000",
          toTokenAmount: (50 / perToken).toFixed(18).replace(/\.?0+$/, ""),
          priceImpactPercent: impact,
          fromToken: {},
          toToken: {},
          dexRouterList: [{ dexProtocol: { dexName: "Test" } }],
        },
      ];
    },
  } as unknown as AggregatorApi;
}

const cachePath = () => join(mkdtempSync(join(tmpdir(), "bnb-tokens-")), "tokens.json");

describe("candidatesOf", () => {
  it("按链与底层 ticker 精确筛候选，并按 volume24H 降序", () => {
    const cands = candidatesOf(LIST, "MSFT");
    expect(cands.map((c) => c.symbol)).toEqual(["MSFTon", "MSFTB"]);
    expect(cands[0]?.shareRatio).toBeCloseTo(1.005731, 6);
  });
});

describe("resolveTokens 链上可成交性选币", () => {
  it("不选 volume24H 更高但无盘口的那枚", async () => {
    const { tokens, illiquid } = await resolveTokens(rwaStub, ["MSFT"], {
      cachePath: cachePath(),
      probe: {
        aggregator: aggStub({ [MSFT_ONDO.tokenContractAddress]: "0.9995010641", [MSFT_BSTOCK.tokenContractAddress]: "0" }),
        userWalletAddress: "0x0000000000000000000000000000000000000001",
        quoteAsset: { address: "0x0000000000000000000000000000000000000002" },
      },
    });
    expect(illiquid).toEqual([]);
    expect(tokens["MSFT"]?.symbol).toBe("MSFTB");
  });

  it("全部候选都无盘口时上报 illiquid，不返回不可交易地址", async () => {
    const { tokens, illiquid, liquidity } = await resolveTokens(rwaStub, ["MSFT"], {
      cachePath: cachePath(),
      probe: {
        aggregator: aggStub({ [MSFT_ONDO.tokenContractAddress]: "0.5", [MSFT_BSTOCK.tokenContractAddress]: "0.9" }),
        userWalletAddress: "0x0000000000000000000000000000000000000001",
        quoteAsset: { address: "0x0000000000000000000000000000000000000002" },
      },
    });
    expect(tokens["MSFT"]).toBeUndefined();
    expect(illiquid).toEqual(["MSFT"]);
    expect(liquidity["MSFT"]?.candidates).toHaveLength(2);
  });

  it("不询价时退回 volume24H 顺序，且候选列表进缓存", async () => {
    const path = cachePath();
    const first = await resolveTokens(rwaStub, ["MSFT"], { cachePath: path });
    expect(first.tokens["MSFT"]?.symbol).toBe("MSFTon");
    const second = await resolveTokens(rwaStub, ["MSFT"], { cachePath: path });
    expect(second.tokens["MSFT"]?.symbol).toBe("MSFTon");
  });
});
