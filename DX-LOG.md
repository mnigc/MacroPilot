# 开发者体验日志（DX Log）

> 黑客松要求提交开发者体验报告，占总分 25%。本文件从项目第一天起记录真实接入体验：
> 卡点、文档问题、API 陷阱、AI 技术栈使用情况。要求具体（哪一页、哪个报错、什么场景），
> 模糊反馈不计分。AI 辅助编码完全可用，但本日志必须真实。

---

## 2026-09-26（D1：文档与认证接入）

**环境**：Windows 11 + Node 22.13.1 + TypeScript 5.8，Git Bash。

### 1. 文档站可访问性
- 直连 `web3.binance.com` 不稳定：`curl -L` 直接 SSL 握手失败（exit 35），普通网页抓取工具被 ECONNRESET 重置。换用服务器端渲染抓取通道才读到全文。**从中国大陆网络接入文档站和（预计）API 网关需要提前验证网络路径**，这对其他同地区参赛者是关键信息。
- 好的一面：官方提供 `llms.txt` / `llms-full.txt`（AI 友好的文档索引），配合 AI 辅助开发非常顺畅，这是比大多数黑客松文档先进的地方。但页面级 `.md` 路径（如 `/dev-docs/authentication.md`）偶发 500（网络错误 id 20260926003130...），渲染版 HTML 路径反而稳定。

### 2. 认证文档的读后体验
- 签名算法本身清晰：`Base64(HMAC-SHA256(SecretKey, timestamp + METHOD + requestPath + body))`，四段直接拼接无分隔符，`X-OC-*` 四个请求头。文档用 Python/Go/Java 三语言给了完整可运行示例——**没有 JavaScript/TypeScript 示例**，对前端背景的开发者是第一个摩擦点（本仓库 `src/binance/signer.ts` 即补齐这个空白的 TS 实现 + 单元测试）。
- 文档明确写了"签名失败最常见原因是漏掉 `/build` 前缀（错误码 40102）"——官方自己承认的头号坑。最初的写法是让参与签名的字符串与实际发送的 URL 完全复用同一个值，从结构上消灭"签名用 A、发送用 B"的分歧（见 `src/binance/client.ts`）；D2 起改为签名用 path、发送用完整 URL（见下条补充）。
- 时间戳格式是 ISO 8601 毫秒（`2026-05-11T10:08:57.715Z`），不是 Unix 秒——和多数交易所 API 习惯不同，值得在文档认证页加粗提示。
- **补充（D2）**：签名入参后来改为 `requestPath = "/build" + path + query`（不含 scheme/host，贴文档字面定义），
  而实际请求仍发完整 URL；D1 记的"签名与发送复用同一字符串"因此不再成立。两种口径哪个被网关接受，
  **只有拿到 key 打真实请求才能定论**——D3 已定论：`requestPath = "/build" + path + 百分号编码 query` 这一套
  被网关接受，30 余次真实调用（含带中文与逗号的 query）无一次 40102。
  同时因为本机直连 `web3.binance.com` 不稳定，客户端改为经 `HTTPS_PROXY` 走 undici `ProxyAgent`，
  并固定 `Accept-Encoding: gzip`（外部 undici 默认要约 zstd，Node 22.13 的 zlib 还解不了）。

### 3. 交易 API 的一个重要发现
- **（D3 更正：此条不成立）** 当时按文档写下"股票/RWA 代币的报价 `executionMode` 恒为 RFQ"，
  并据此搭建了整条执行链；真实询价返回的是 `executionMode="SWAP"` + 可直接广播的 `tx`。
  RFQ 看起来是路由的一种而非股票代币的固定模式（部分路由名确含 `Rfq Halfmoon`/`Rfq Native`）。原文保留如下，作为"文档优先于实测的代价"记录。

  股票/RWA 代币的报价 `executionMode` 恒为 **RFQ（做市商询价）**，与普通代币的 AMM 兑换是两套执行链路：quote 必须传 `userWalletAddress`（文档没有显著强调，首次调用容易漏）、swap 返回的是 EIP-712 `typedDataToSign` 而非可广播交易、还要再 `POST /order/submit` + 轮询订单状态。**文档把 RFQ 流程写在普通 swap 流程之后作为变体，但对"做股票"这个黑客松主题来说它才是主路径**，建议官方文档为代币化股票单开一条端到端教程。
- `quoteId` 有效期约 30 秒、`requestId` 幂等键 30 分钟有效——这些数字散落在文档各处，汇总成一张"时效参数表"会省很多时间。
- 代码示例里 USDT（BSC）地址 `0x55d3...7955` 硬编码出现，但没有列出"股票篮子常用的基础资产清单"。

### 4. 待验证清单（拿到 API key 后）—— 2026-09-26 已勾完，答案见 D3
- [x] RWA Data API 各端点的真实响应字段（`rwa.ts` 已按真实响应重写，字段名几乎全对不上文档）
- [x] 板块筛选：未验证 `sector` 取值；`listTokens({chainId:"56"})` 实测返回 BSC 全量 488 枚（`limit` 给 200 也返回 488，该参数似乎不参与截断）
- [x] `/rwa/search` 用 `NVDA` / `APPLE` 哪个关键词能命中 —— 两者都行，但它是**模糊匹配**（搜 `META` 会带出 `SCCO`），不能当解析器用
- [x] marketStatus 在美股休市时是否仍更新 —— 更新。休市态记在 `statusInfo.reasonCode`/`marketStatus="offhours"`，`tokenPrice` 仍在变（因为它就是参考价的折算）
- [x] RFQ 报价的最小/最大金额限制 —— 50 USDT 询价通过；但当前 BSC 上股票代币返回的是 `executionMode=SWAP`，不是 RFQ（详见 D3）

<!-- 每天在此文件追加新章节 -->

## 2026-09-26（D2：自我审计——真实数据暴露的 5 个正确性缺陷）

拿到 API 配额之前先做了一轮自查，把"能跑通"和"结论成立"分开验证。用真实 FRED + Mag7
数据（2020-01-02 → 2026-09-22，1689 个交易日）跑端到端，发现的都是会在评审时被追问倒的问题：

**1. `neutral` 档从来不存在。**  README 宣传 100%/60%/25% 三档仓位，实际回测出来的体制分布是
`{riskOn: 1288, riskOff: 401, neutral: 0}`。分数分布本身没问题——p5=0.167、中位=0.539、p95=0.710，
**930/1689（55%）个交易日确实落在 0.3~0.6 的中间带里**。根因是状态机只写了"进入极态"的两条边沿
（`score>=high`、`score<=low`），没有写"离开极态"的边沿，于是 neutral 只是初始值，一旦离开永久不可达。
补上释放内沿 `scoreRelease=0.45` 后变成真正的三态 Schmitt 触发器：`{riskOn: 891, neutral: 504, riskOff: 294}`，
2022 年有 240 个交易日停在 25% 防御仓位。教训：**滞回系统必须成对检查外沿与内沿**，单边滞回会静默退化成开关。

**2. 组合账上出现负现金。** 期末 `cash = -0.000176`。原因是买入按"权益 × 目标仓位"全额下单后
再扣 `costBps` 手续费——成本没有进入仓位规模，满仓（risk-on 100%）时必然透支。修复是买入额受
可用现金硬约束（`min(target, cash/(1+fee))`）并先卖后买；同时让**基准腿也计同样的费率**，
否则"策略被单边成本拖累"的对照不成立。

**3. 交易归因是错的。** 整批交易只打一个标签、优先级 `seed > dca > drift`，于是周五恰逢体制切换时
所有成交都记成 `dca`。而"每个引擎各贡献了多少"正是本项目的核心叙事。改为逐笔记录**全部**触发引擎
（`seed/dca/regime/drift/earnings` 多值），前端渲染多枚徽章。顺带发现执行器根本没有"体制是否切换"的
概念（只看得见瞬时分数），因此新增 `runtime_state` 表持久化上一轮仓位档，`regime` 这一档才可能为真。

**4. 财报引擎在空转。** `scripts/sync-prices.py` 早就实现了 `sync_earnings()`，但
`.github/workflows/sync-data.yml` 只 `git add data/prices`——财报日历 CSV 生成了却从未提交，
`data/earnings/` 是空目录，`earnings_dates` 表自然全空。另外导入函数原本"表非空即跳过"，
即使数据补上、后续新增的财报日也永远进不来，改成幂等 upsert。

**5. `viem` 是依赖但全项目 0 引用。** 所谓"链上执行"当时只有类型化 HTTP 封装。补齐
`src/exec/live.ts`（quote→approve→swap→本地 EIP-712 签名→order/submit→轮询）与
`src/binance/tokens.ts`（ticker→合约地址解析并缓存 `data/tokens.json`）。写离线验签测试时
立刻抓到一个真实 API 误用：`signTypedData({account})` 低层入口实际收 `privateKey`，正确写法是
`account.signTypedData({...})`——真跑主网必然在签名步失败。**没有那次测试这段代码就会带着这个 bug 上线。**

**流程侧的记录**：本环境的安全策略禁止 agent 写入凭据文件（同一操作连续拦截 3 次，即使用户已口头授权），
最终仍需人工粘贴 `.env`。对黑客松场景这是一条真实 DX 摩擦：**"AI 写代码、人管密钥"的边界要提前设计**，
例如提供 `--env-file` 或一次性凭据传递入口，而不是让参赛者反复试。

**AI 辅助说明**：本轮全部改动由 AI 结对编写，人工逐条复核；每个缺陷都补了回归测试钉住
（`npm test` 22 项，含负现金、三态可达、多驱动归因、EIP-712 验签），类型检查与 Astro 构建通过。

## 2026-09-26（D3：真实 API 把猜测全部打回原形）

填好 key 之后第一轮全部只读调用（不签名、不广播）。结论是：**D1 凭文档写的类型和链路假设，
十条里错了七条**。逐条记录，因为它们每一个都会让"能跑通"的 demo 在评审现场翻车。

**1. 链 ID 参数名一律是 `binanceChainId`，不是 `chainId`。** RWA 数据端点与聚合器端点都是。
传 `chainId` 得到 `40001 Parameter binanceChainId is required`——好在报错诚实。更麻烦的是
`/rwa/price` 与 `/rwa/underlying-market` 收 `binanceChainId`，`/rwa/tokens` 收 `chainId`，
同一命名空间两套参数名，只能逐个试出来。链 ID 的取值还是**字符串**且不止 EVM：`"56"`、`"1"`、`"CT_501"`。

**2. 数值字段全是高精度字符串。** `"225.030322065775128621"`、`decimals:"18"`、
`tokenToShareRatio:"1.0017152487959898"`。`Number()` 之前不做转换就会在比较处静默出错，
所以统一走 `toNumber()`，空值返回 `undefined` 而不是 `0`——把"缺数据"当 0 是回测里最难查的那类错。

**3. 最致命的一条：所谓"链上价"根本不是成交价。**
`/rwa/price` 的 `tokenPrice` 与 `referencePrice` 严格满足
`tokenPrice ≡ referencePrice × tokenToShareRatio`（Mag7 七只全部命中，折算到每股口径后溢价**精确等于 0.000%**）。
`/rwa/kline` 更明白：OHLC 四个值完全相等、volume 恒为 `null`、`period` 参数被忽略（永远 1 分钟粒度）。
也就是说这条数据是给"显示净值"用的，**不含盘口**，本项目原本打算讲的"链上-参考价差"故事在这个数据源上不成立。

出路是问聚合器：`/dex/aggregator/quote` 给出真实可成交的 `fromTokenAmount/toTokenAmount`，
用它反推每股可成交价再比参考价。50 USDT 一笔的实测溢价：
NVDA +1.36% / AMZN +1.54% / GOOGL +1.06% / MSFT +0.85% / META +0.08% / AAPL −0.01% / TSLA +0.06%，
且**同一对代币两次询价走的是不同路由**（`Rfq Halfmoon`、`Pancakeswap V3`、`Rfq Native`、`Metric`）——
差价由路由与深度决定，这才是一个值得盯的数。监控口径与页面因此整体重写（`npm run spread` → `rwa_premiums` 表 → `/spread`）。
（这批数字采于下面第 9 条修正之前：当时 GOOGL/MSFT/NVDA 用的是没有盘口的 ondo 那枚，修正选币后为
NVDA +0.11% / MSFT +0.28% / GOOGL +0.15%。）

**4. RWA 代币不是 RFQ 专属。** D1 依据文档写下"股票/RWA 代币 executionMode 恒为 RFQ"，
整条 live 链路（swap 返回 typedData → 本地签名 → order/submit → 轮询）都是照这个假设搭的。
实测 `executionMode="SWAP"`，`/swap` 直接返回可广播的 `tx{to,data,value,gas,gasPrice}`。
已改为按 `executionMode` 分支：SWAP 走广播、RFQ 保留签名链路的另一条腿。
`tx.from` 是服务端地址，广播前必须丢掉，否则 viem 会签错主体。

**5. `priceImpactPercent` 是小数字符串。** `"0.0009363173"` 表示 **0.0936%**。原护栏写作
`if (impact > maxPriceImpactPercent /* 1.0 */)` 直接拿小数比百分数，阈值实际相当于 100%，
冲击成本护栏形同虚设。补了 `impactPercent()` 换算与断言（`tests/live.test.ts`）。

**6. 响应字段名与文档不符。** `fromTokenAmount`/`toTokenAmount`（不是 `fromAmount`/`toAmount`），
报价里**没有** `minToAmount`——滑点下限在 `/swap` 的 `tx.minReceiveAmount`。
`approve-transaction` 的参数是 `tokenContractAddress` + `approveAmount`（不是 `token`/`amount`），
返回**数组** `[{data, dexContractAddress, gasLimit, gasPrice}]`。

**7. 两个没写进文档但很好用的端点。** `/rwa/underlying-profile` 有公司基本面和
**每日/每月储备证明 PDF**（`protections.dailyAttestationReport.url`）——"链上资产可验证"的现成材料；
`/rwa/kline` 见上。反向确认不存在的：`candlestick`/`history`/`trades`/`detail`/`spread` 全部 404。

**8. `/rwa/search` 是模糊匹配，不能当解析器。** 搜 `META` 会带出 `SCCO`，搜 `GOOGL` 会带出 `GOOG`，
而且返回里没有 `decimals` 与 `tokenToShareRatio`。ticker→合约地址的解析改成走一次
`/rwa/tokens`（BSC 538 枚全量：ondo 458 + bstock 80）+ 24h TTL 缓存 `data/tokens.json`：份额比会逐日漂移，
把解析结果永久缓存会让溢价算法悄悄失真——这条 TTL 是数据正确性问题，不是性能问题。

**9. `volume24H` 是美股的成交额，不是链上流动性——按它选币会选中没有市场的代币。**
第一轮真实溢价表里 MSFT 一行是 `可成交单价 10.2 亿美元 / 溢价 +197932519%`。算术没坏：
50 USDT 询价回来的 `toTokenAmount` 是 `48529935334`（18 精度 → 4.85e-8 枚），报价自带的
`priceImpactPercent` 是 `0.9995`（99.95%），即链上根本没人挂 MSFTon 的卖单。而我们当时按
`/rwa/tokens` 的 `volume24H` 降序在同一 ticker 的多枚候选（ondo 与 bstock 各一枚）里挑流动性"最好"的，
挑到的正是这枚——MSFT 两枚的 `volume24H` 分别是 197.6 亿与 173.6 亿，都是**底层美股**的量，
跟链上有没有市场毫无关系。
修法是选币阶段就问聚合器：对每枚候选各询一笔价，剔除冲击成本 >25%（等于没有市场）的，剩下的按冲击升序取第一枚
（`src/binance/tokens.ts` 的 `resolveTokens({probe})`，`tests/tokens.test.ts` 用真实两枚地址锁住这个行为）。
同一轮实测的候选成色：MSFT `MSFTon 99.95% / MSFTB 0.00%`、GOOGL `GOOGLon 1.11% / GOOGLB 0.04%`、
NVDA `NVDAon 0.094% / NVDAB 0.024%`、META `METAon 0.00% / METAB 0.00%`。
所以篮子现在混合两个发行方（7 只里 ondo 4 枚 + bstock 3 枚），且每轮采集都会重新按可成交性选一枚。
**文档里没有任何一处提示 `volume24H` 的口径**，字段名在 RWA 列表上下文里最自然的理解就是"这枚代币的成交额"。

**给主办方的四条建议**：① 参数命名统一（`chainId` vs `binanceChainId` 在同一命名空间混用）；
② 给 `tokenPrice` 在文档里标"发行方净值标记，非盘口"，或补一个真正的 last-trade / bid-ask 端点——
现在所有参赛者算出的"价差"都会是 0，而这不是他们的 bug；③ 给 `/rwa/tokens` 的字段标口径
（`volume24H` 是底层股票量还是链上代币量），并补一个链上流动性/深度指标，否则"选哪一枚代币"只能靠逐枚询价试出来；
④ 文档说明 `executionMode` 在什么条件下返回 RFQ，否则会像我们一样把整条执行链按错误的模式搭起来。

**仍未验证**（诚实口径）：真实广播、RFQ 分支往返、限流阈值。前两项需要一只充值后的小额钱包，
纸面模式不受影响。
