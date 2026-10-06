#!/usr/bin/env python3
"""抓取 OpenNews 新闻情绪日读数到 data/news/sentiment.csv（情绪叠加层引擎的数据源）。

    python scripts/sync-news.py        # 需要 OPENNEWS_TOKEN（环境变量或 .env）

每日一次（sync-data workflow，美股收盘后）：取最新 100 条高影响新闻（服务端
engineTypes=news + score≥60 双过滤，过滤掉 twitter/通稿/低影响噪声），按 AI 已标注的
long/short 信号算净宽度：

    value = 50 + 50 × (多 − 空) / (多 + 空)     # 0~100，50 = 中性

读数记在**同步日**（UTC）名下：收盘后抓的是刚结束那个交易日的新闻流，下一交易日
消费它，时间顺序天然正确。历史无法回填（翻页回溯约 500 PTS），序列从启用日起逐日
积累；引擎侧带 minObs 守卫，读数攒够之前偏移按 undefined（关闭）处理。

计费 1 PTS/20 条：limit=100 一次 = 5 PTS，× 交易日 ≈ 110 PTS/月。
抓取失败**不**使 CI 失败——情绪引擎在没有文件/读数不足时按关闭处理并在站点标注。
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import urllib.request

OUT = Path("data/news/sentiment.csv")
LATEST = Path("data/news/latest.json")
URL = "https://ai.6551.io/open/news_search"
# 服务端过滤：只要 news 引擎 + AI 影响分 ≥ 60 的高影响条目（双过滤缺一不可，
# 原始流混着 twitter/塔斯社/通稿，不过滤的情绪均值全是噪声）
BODY = {"limit": 100, "page": 1, "engineTypes": {"news": []}, "score": 60}
# 当日多空样本不足这个数时不写行（两三条的宽度是掷硬币，宁缺毋滥留空档）
MIN_DIRECTIONAL = 3
# 站点新闻情绪流展示的条数上限（latest.json）
TICKER_ITEMS = 30
RETRIES = 3


def load_dotenv_fallback() -> None:
    """本地跑时从 .env 补齐 OPENNEWS_TOKEN / HTTPS_PROXY（不覆盖已有环境变量）。"""
    path = Path(".env")
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


def fetch_once() -> list[dict]:
    token = os.environ.get("OPENNEWS_TOKEN")
    if not token:
        raise RuntimeError("OPENNEWS_TOKEN 未配置")
    req = urllib.request.Request(
        URL,
        data=json.dumps(BODY).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    items = payload.get("data")
    if not isinstance(items, list):
        raise ValueError(f"响应无 data 列表：{list(payload.keys())}")
    return items


def collect(items: list[dict]) -> tuple[list[dict], int, int, int]:
    """去重后拆出 (展示条目, nLong, nShort, nRated)，按 ts 新→旧排。"""
    seen: set[int] = set()
    ticker: list[dict] = []
    n_long = n_short = n_rated = 0
    for it in items:
        if not isinstance(it, dict) or it.get("id") in seen:
            continue
        seen.add(it["id"])
        rating = it.get("aiRating")
        if not isinstance(rating, dict) or rating.get("status") != "done":
            continue
        n_rated += 1
        signal = rating.get("signal")
        if signal == "long":
            n_long += 1
        elif signal == "short":
            n_short += 1
        text = " ".join(str(it.get("text") or it.get("description") or "").split())
        if text and len(ticker) < TICKER_ITEMS:
            ticker.append(
                {
                    "ts": it.get("ts"),
                    "source": it.get("newsType") or it.get("source") or "",
                    "text": text[:160],
                    "signal": signal if signal in ("long", "short", "neutral") else "neutral",
                    "score": rating.get("score"),
                    "link": it.get("link") or "",
                }
            )
    ticker.sort(key=lambda x: str(x.get("ts") or ""), reverse=True)
    return ticker, n_long, n_short, n_rated


def main() -> int:
    load_dotenv_fallback()
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            items = fetch_once()
            ticker, n_long, n_short, n_rated = collect(items)
            break
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(10 * (attempt + 1))
    else:
        print(f"news sync FAILED（情绪引擎将按关闭处理）: {last}")
        return 0  # 不让价格/财报管道为它失败

    # latest.json（站点新闻情绪流）即使当日多空样本不足也照写——读数宁缺毋滥，展示不必
    LATEST.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "value": round(50 + 50 * (n_long - n_short) / (n_long + n_short), 2) if n_long + n_short else None,
        "long": n_long,
        "short": n_short,
        "rated": n_rated,
        "items": ticker,
    }
    LATEST.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows: dict[str, float] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines()[1:]:
            if not line:
                continue
            d, _, v = line.partition(",")
            if d and v:
                rows[d] = float(v)

    if n_long + n_short < MIN_DIRECTIONAL:
        print(
            f"news sync: {len(items)} 条（rated {n_rated}）多空样本不足 {MIN_DIRECTIONAL} 条，今日不写读数"
            f"（latest.json 已更新 {len(ticker)} 条）"
        )
        return 0

    value = payload["value"]
    rows[today] = value  # type: ignore[assignment]  # 同日重跑覆盖为最新读数
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        f.write("date,value\n")
        for d in sorted(rows):
            f.write(f"{d},{rows[d]:.2f}\n")
    print(
        f"news sync: {len(items)} 条（rated {n_rated}）→ 多 {n_long} / 空 {n_short}，"
        f"读数 {value:.1f}（50=中性）· 序列累计 {len(rows)} 天（{min(rows)} → {today}）· 情绪流 {len(ticker)} 条"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
