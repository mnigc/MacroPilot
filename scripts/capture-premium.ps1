# 溢价快照采集（必须从本机跑）
#
# 币安 Web3 API 按出口 IP 做合规拦截：从 GitHub runner 调用返回
# 40304 "Service not available due to compliance restriction"，换 IPv4 也一样。
# 所以 rwa_premiums 这一路不能交给托管 CI，只能由有可用出口 IP 的机器采集。
#
# 用法（计划任务每天早上调用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/capture-premium.ps1
#
# 全程只读：只询价，不签名、不广播。
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

npm run spread
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 链上日线：公共 wallet-direct 端点一次给 300 根，重跑即覆盖当天，所以它既是每日积累也是自愈
# ——哪天机器没开机，第二天补回来，历史不会缺洞。
npm run candles
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 站点是构建期读库的静态产物，写完库要 push 一次才能刷新页面。
# 时间戳文件同时充当线上数据新鲜度的公开凭据（https://…/last-run.txt）。
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
New-Item -ItemType Directory -Force -Path web/public | Out-Null
Set-Content -Path web/public/last-run.txt -Value $stamp -Encoding ascii -NoNewline

git add web/public/last-run.txt
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Output '时间戳无变化，跳过提交'
  exit 0
}
git commit -m "chore: premium snapshot $stamp"

# GitHub 推送走本机代理，不改全局配置。代理没开时把这两行的 -c 参数去掉即可。
$proxyArgs = @('-c', 'http.proxy=http://127.0.0.1:7890', '-c', 'https.proxy=http://127.0.0.1:7890')
git @proxyArgs pull --rebase origin main
git @proxyArgs push origin HEAD:main
