#!/usr/bin/env python3
"""抓取 Shiller CAPE 月度序列到 data/valuation/cape.csv（估值锚引擎的数据源）。

    python scripts/sync-valuation.py

数据源 multpl.com 的月度表格（公共页面）。抓取失败**不**使 CI 失败——估值锚引擎
在没有 CAPE 文件时按关闭处理并在站点明确标注；但价格同步不能被它拖累。
"""
import io
import sys
import time
from pathlib import Path

import pandas as pd

OUT = Path("data/valuation/cape.csv")
URL = "https://www.multpl.com/shiller-pe/table/by-month"
UA = {"User-Agent": "Mozilla/5.0 (MacroPilot data sync; contact: repo issues)"}


def fetch_once() -> pd.DataFrame:
    tables = pd.read_html(io.StringIO(_get(URL)))
    # 页面只有一个主数据表：Date / Value
    for t in tables:
        cols = [c.lower() for c in t.columns]
        if any("date" in c for c in cols) and any("value" in c for c in cols):
            t.columns = [c.lower() for c in t.columns]
            return t
    raise ValueError("no date/value table found")


def _get(url: str) -> str:
    import urllib.request

    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return resp.read().decode("utf-8", errors="replace")


def main() -> int:
    last: Exception | None = None
    for attempt in range(3):
        try:
            t = fetch_once()
            date_col = next(c for c in t.columns if "date" in c)
            value_col = next(c for c in t.columns if "value" in c)
            t = t[[date_col, value_col]].rename(columns={date_col: "date", value_col: "value"})
            t["date"] = pd.to_datetime(t["date"], errors="coerce")
            t["value"] = pd.to_numeric(t["value"], errors="coerce")
            t = t.dropna().sort_values("date")
            # 页面顶部有一行"当日快照"（日期是抓取日，非月初）。剔除它保持纯月度语义：
            # 否则同月出现两行、且每次同步该行日期都变，文件不可复现
            t = t[t["date"].dt.day == 1]
            if len(t) < 240:
                raise ValueError(f"only {len(t)} rows — page layout changed?")
            OUT.parent.mkdir(parents=True, exist_ok=True)
            with open(OUT, "w", newline="") as f:
                f.write("date,value\n")
                for _, row in t.iterrows():
                    f.write(f"{row['date'].strftime('%Y-%m-%d')},{row['value']:.2f}\n")
            print(f"CAPE: {len(t)} rows（{t['date'].min().date()} → {t['date'].max().date()}，最新 {t['value'].iloc[-1]:.2f}）")
            return 0
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(10 * (attempt + 1))
    print(f"CAPE sync FAILED（估值锚引擎将按关闭处理）: {last}")
    return 0  # 不让价格/财报管道为它失败


if __name__ == "__main__":
    sys.exit(main())
