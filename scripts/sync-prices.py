#!/usr/bin/env python3
"""同步 Mag7 股价历史（含成交量）与财报日历（含多年历史）到 data/prices 与 data/earnings。

    python scripts/sync-prices.py                   # 两者都同步
    python scripts/sync-prices.py --earnings-only   # 只补财报日历

本地可用时直接跑；Yahoo 按 IP 限流，本地常拿到 YFRateLimitError，此时由
GitHub Actions 定时执行——见 .github/workflows/sync-data.yml。
成交量是逐笔成本模型（半价差+√冲击，按 ADV20）的数据源，缺失时成本退回平坦假设。
财报日历用 get_earnings_dates(limit=40) 尽量回填历史——财报引擎因此才能进回测，
只有未来几个季度的话回测里它永远不触发。
"""
import csv
import sys
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

TICKERS = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA"]
OUT_DIR = Path("data/prices")
EARNINGS_DIR = Path("data/earnings")
OUT_DIR.mkdir(parents=True, exist_ok=True)
EARNINGS_DIR.mkdir(parents=True, exist_ok=True)


def sync_earnings(ticker: str, retries: int = 3) -> int | None:
    """同步财报日期：未来几季（执行器避险窗口）+ 尽量多的历史（回测财报引擎）。
    失败返回 None——与"成功但为空"区分开，部分失败不能再静默绿灯。"""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            dates = yf.Ticker(ticker).get_earnings_dates(limit=40)
            if dates is None or len(dates) == 0:
                raise ValueError("empty earnings calendar")
            days = sorted((idx.date() if hasattr(idx, "date") else idx).strftime("%Y-%m-%d") for idx in dates.index)
            with open(EARNINGS_DIR / f"{ticker}.csv", "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["date", "value"])
                writer.writerows([d, "1"] for d in days)
            hist = sum(1 for d in days if d < str(pd.Timestamp.utcnow().date()))
            print(f"{ticker}: {len(days)} earnings dates（历史 {hist} + 未来 {len(days) - hist}）")
            return len(days)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(10 * (attempt + 1))
    print(f"{ticker}: earnings sync FAILED after {retries} attempts ({last})")
    return None


def _col(df, name: str):
    """auto_adjust=True 下 OHLC 全部复权；单标的查询仍带 (col, ticker) 多级表头，需压平。"""
    s = df[name]
    return s.iloc[:, 0] if hasattr(s, "columns") else s


def sync(ticker: str, retries: int = 3) -> bool:
    for attempt in range(retries):
        try:
            df = yf.download(ticker, period="max", interval="1d", progress=False, auto_adjust=True)
            if df.empty:
                raise ValueError("empty frame")

            o, h, l, c, v = (_col(df, k) for k in ("Open", "High", "Low", "Close", "Volume"))
            with open(OUT_DIR / f"{ticker}.csv", "w", newline="") as f:
                writer = csv.writer(f)
                # 列名保留 close：回测与 prices 表只吃 close；volume 供 ADV 冲击成本模型。
                writer.writerow(["date", "open", "high", "low", "close", "volume"])
                for date, ov, hv, lv, cv, vv in zip(c.index, o, h, l, c, v):
                    if pd.isna(cv):
                        continue
                    # 停牌日 Yahoo 会把 OHLC 留空，退化成一根十字线而不是丢掉整行
                    vals = [float(x) if not pd.isna(x) else float(cv) for x in (ov, hv, lv, cv)]
                    vol = "" if pd.isna(vv) else f"{float(vv):.0f}"
                    writer.writerow([date.strftime("%Y-%m-%d"), *(f"{x:.6f}" for x in vals), vol])
            print(f"{ticker}: {len(c)} rows (OHLCV)")
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"{ticker}: attempt {attempt + 1} failed ({exc})")
            time.sleep(10 * (attempt + 1))
    return False


if __name__ == "__main__":
    earnings_only = "--earnings-only" in sys.argv
    if not earnings_only:
        results = {t: sync(t) for t in TICKERS}
        failed = [t for t, ok in results.items() if not ok]
        if failed:
            raise SystemExit(f"price sync failed: {failed}")
    earn_results = {t: sync_earnings(t) for t in TICKERS}
    earn_failed = [t for t, r in earn_results.items() if r is None]
    earnings_total = sum(r or 0 for r in earn_results.values())
    print(f"earnings dates total: {earnings_total}")
    if earn_failed:
        # 部分失败也要亮出来：那几只的日历静默变陈旧，执行器的财报避险会漏掉它们
        print(f"⚠ earnings sync FAILED for: {', '.join(earn_failed)} —— 这几只日历将保持陈旧")
        if earnings_only:
            raise SystemExit(f"earnings sync failed: {earn_failed}")
    if earnings_total == 0:
        raise SystemExit("财报日历为空：财报引擎不会触发。多为 Yahoo 按 IP 限流，改由 CI 执行。")
