/**
 * 生成 live 模式要用的**专用小额**钱包（BSC / EVM 私钥，本地生成，不经过任何第三方）。
 *   npx tsx scripts/new-wallet.ts            → 私钥与地址都打到屏幕上，自己粘进 .env
 *   npx tsx scripts/new-wallet.ts --save     → 直接写进 .env 的两个字段，私钥不上屏
 *   npx tsx scripts/new-wallet.ts --save --force  → 允许覆盖 .env 里已有的私钥
 *
 * 这只钱包只做"验证一次真实广播"这一件事，跑完就可以放弃。
 * 私钥只要出现在终端历史、聊天记录或截图里，就该当作已泄露——换一只，别救。
 * 已有非空私钥时默认拒绝覆盖：那可能是一只**已经充了钱**的钱包，写错了钱就找不回来。
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const save = args.includes("--save");
const force = args.includes("--force");
const envPath = ".env";

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

if (!save) {
  console.log(`地址（收款用）  ${account.address}`);
  console.log(`私钥（.env）    ${pk}`);
  console.log("\n两行分别填进 .env 的 PORTFOLIO_ADDRESS 与 WALLET_PRIVATE_KEY。屏幕上的私钥关掉终端就没了，别贴进任何聊天工具。");
  process.exit(0);
}

if (!existsSync(envPath)) {
  console.error("当前目录没有 .env（先 cp .env.example .env）");
  process.exit(1);
}
const original = readFileSync(envPath, "utf8");
// 只吃水平空白：\s 会把换行也吞掉，于是"这一行为空"会被读成"下一行的内容"
const current = /^[ \t]*WALLET_PRIVATE_KEY[ \t]*=[ \t]*(.*)$/m.exec(original)?.[1]?.trim() ?? "";
if (current && !force) {
  console.error(`.env 里已有非空 WALLET_PRIVATE_KEY（${current.slice(0, 4)}…）。要覆盖它请加 --force —— 如果那只地址已经充过钱，先确认备份还在。`);
  process.exit(1);
}

const setLine = (text: string, key: string, value: string): string => {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, "")}\n${key}=${value}\n`;
};

const next = setLine(setLine(original, "WALLET_PRIVATE_KEY", pk), "PORTFOLIO_ADDRESS", account.address);
writeFileSync(envPath, next, "utf8");

console.log(`已写入 .env（WALLET_PRIVATE_KEY + PORTFOLIO_ADDRESS，两者是同一只钱包）`);
console.log(`地址（收款用）  ${account.address}`);
console.log("私钥没有出现在屏幕上，只落在这份文件里；.env 已在 .gitignore 第 3 行，不会被提交。");
