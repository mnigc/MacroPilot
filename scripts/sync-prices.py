#!/usr/bin/env python3
"""同步 Mag7 股价历史到 data/prices/{TICKER}.csv（date,close）。

本地可用时直接跑：python scripts/sync-prices.py
本地被限流时（YFRateLimitError）由 GitHub Actions 定时执行——见
.github/workflows/sync-data.yml，与 invest-platform 的同步模式一致。
"""
import csv
import time
from pathlib import Path

import yfinance as yf

TICKERS = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA"]
OUT_DIR = Path("data/prices")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def sync(ticker: str, retries: int = 3) -> bool:
    for attempt in range(retries):
        try:
            df = yf.download(ticker, period="max", interval="1d", progress=False, auto_adjust=True)
            if df.empty:
                raise ValueError("empty frame")
            close = df["Close"]
            if hasattr(close, "columns"):  # MultiIndex 时取单列
                close = close.iloc[:, 0]
            with open(OUT_DIR / f"{ticker}.csv", "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["date", "value"])
                for date, value in close.items():
                    writer.writerow([date.strftime("%Y-%m-%d"), f"{float(value):.6f}"])
            print(f"{ticker}: {len(close)} rows")
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"{ticker}: attempt {attempt + 1} failed ({exc})")
            time.sleep(10 * (attempt + 1))
    return False


if __name__ == "__main__":
    results = {t: sync(t) for t in TICKERS}
    failed = [t for t, ok in results.items() if not ok]
    raise SystemExit(f"failed: {failed}" if failed else 0)
