#!/usr/bin/env python3
"""同步 Mag7 股价历史与财报日历到 data/prices 与 data/earnings。

    python scripts/sync-prices.py                   # 两者都同步
    python scripts/sync-prices.py --earnings-only   # 只补财报日历

本地可用时直接跑；Yahoo 按 IP 限流，本地常拿到 YFRateLimitError，此时由
GitHub Actions 定时执行——见 .github/workflows/sync-data.yml。
财报日历是财报引擎的唯一输入：它为空时引擎会静默不触发，所以本脚本在
--earnings-only 下若一条都没同步到就以非零码退出，让 CI 显式失败而不是留下空表。
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


def sync_earnings(ticker: str, retries: int = 3) -> int:
    """同步财报日期（历史 + 未来各数个季度），供财报引擎判断避险窗口。"""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            dates = yf.Ticker(ticker).get_earnings_dates(limit=12)
            if dates is None or len(dates) == 0:
                raise ValueError("empty earnings calendar")
            days = sorted((idx.date() if hasattr(idx, "date") else idx).strftime("%Y-%m-%d") for idx in dates.index)
            with open(EARNINGS_DIR / f"{ticker}.csv", "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["date", "value"])
                writer.writerows([d, "1"] for d in days)
            print(f"{ticker}: {len(days)} earnings dates ({days[0]} → {days[-1]})")
            return len(days)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(10 * (attempt + 1))
    print(f"{ticker}: earnings sync FAILED after {retries} attempts ({last})")
    return 0


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

            o, h, l, c = (_col(df, k) for k in ("Open", "High", "Low", "Close"))
            with open(OUT_DIR / f"{ticker}.csv", "w", newline="") as f:
                writer = csv.writer(f)
                # 列名保留 close：回测与 prices 表只吃 close，open/high/low 只服务展示层 K 线。
                writer.writerow(["date", "open", "high", "low", "close"])
                for date, ov, hv, lv, cv in zip(c.index, o, h, l, c):
                    if pd.isna(cv):
                        continue
                    # 停牌日 Yahoo 会把 OHLC 留空，退化成一根十字线而不是丢掉整行
                    vals = [float(v) if not pd.isna(v) else float(cv) for v in (ov, hv, lv, cv)]
                    writer.writerow([date.strftime("%Y-%m-%d"), *(f"{v:.6f}" for v in vals)])
            print(f"{ticker}: {len(c)} rows (OHLC)")
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
    earnings_total = sum(sync_earnings(t) for t in TICKERS)
    print(f"earnings dates total: {earnings_total}")
    if earnings_total == 0:
        raise SystemExit("财报日历为空：财报引擎不会触发。多为 Yahoo 按 IP 限流，改由 CI 执行。")
