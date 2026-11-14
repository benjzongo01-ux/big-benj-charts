"""Connecteur Yahoo Finance : actions, ETF et indices (mêmes données que yfinance, sans dépendance lourde).

Limites de la source gratuite : 1m sur 7 jours, 5m-30m sur 60 jours, 1h sur 2 ans, 1d/1w illimité.
Les prix « temps réel » sont différés selon la place boursière.
"""
from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator

import httpx
import numpy as np

from .base import EMPTY, Connector, ConnectorError, clean, resample, tf_ms

URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
INTERVALS = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "2h": "60m", "4h": "60m", "1d": "1d", "1w": "1wk"}
MAX_AGE_DAYS = {"1m": 7, "5m": 59, "15m": 59, "30m": 59, "1h": 729, "2h": 729, "4h": 729}

STOCKS = [
    ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "Nvidia"), ("GOOGL", "Alphabet"), ("AMZN", "Amazon"),
    ("META", "Meta"), ("TSLA", "Tesla"), ("NFLX", "Netflix"), ("AMD", "AMD"), ("JPM", "JPMorgan"),
    ("V", "Visa"), ("KO", "Coca-Cola"), ("DIS", "Disney"), ("BA", "Boeing"), ("INTC", "Intel"),
    ("MC.PA", "LVMH"), ("TTE.PA", "TotalEnergies"), ("AIR.PA", "Airbus"), ("OR.PA", "L'Oréal"),
    ("SPY", "ETF S&P 500"), ("QQQ", "ETF Nasdaq 100"),
    ("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq Composite"), ("^DJI", "Dow Jones"), ("^FCHI", "CAC 40"), ("^GDAXI", "DAX"),
]


class YahooConnector(Connector):
    name = "yahoo"
    label = "Yahoo Finance"
    markets = ("actions", "indices")

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=20, headers={"User-Agent": "Mozilla/5.0"})

    async def symbols(self) -> list[dict]:
        return [{"symbol": s, "name": n, "market": "indices" if s.startswith("^") else "actions", "precision": 2}
                for s, n in STOCKS]

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        now = int(time.time())
        p1, p2 = start_ms // 1000, min(end_ms // 1000 + 1, now)
        if tf in MAX_AGE_DAYS:
            p1 = max(p1, now - MAX_AGE_DAYS[tf] * 86400)
        if p1 >= p2:
            return EMPTY
        try:
            r = await self._client.get(URL + symbol, params={
                "interval": INTERVALS[tf], "period1": p1, "period2": p2, "includePrePost": "false"})
        except httpx.HTTPError as exc:
            raise ConnectorError(f"Yahoo Finance injoignable : {exc}") from exc
        if r.status_code == 429:
            raise ConnectorError("Yahoo Finance : limite de requêtes atteinte, réessaie plus tard.")
        if r.status_code == 404:
            raise ConnectorError(f"Yahoo Finance : symbole inconnu « {symbol} ».")
        try:
            res = r.json()["chart"]["result"][0]
            ts = res.get("timestamp") or []
            q = res["indicators"]["quote"][0]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ConnectorError("Yahoo Finance : réponse inattendue (données manquantes).") from exc
        if not ts:
            return EMPTY
        rows = np.array([np.array(ts, dtype=np.float64) * 1000,
                         np.array(q["open"], dtype=np.float64), np.array(q["high"], dtype=np.float64),
                         np.array(q["low"], dtype=np.float64), np.array(q["close"], dtype=np.float64),
                         np.nan_to_num(np.array(q["volume"], dtype=np.float64))]).T
        rows = clean(rows)
        if tf in ("1d", "1w"):
            rows[:, 0] = rows[:, 0] // 86400_000 * 86400_000  # bougies journalières calées à minuit UTC
            rows = clean(rows)
        if tf in ("2h", "4h"):
            rows = resample(rows, tf)
        return rows

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        step = tf_ms(tf)
        while True:
            now = int(time.time() * 1000)
            try:
                rows = await self.get_history(symbol, tf, now - max(step * 5, 5 * 86400_000), now)
                if rows.size:
                    yield rows[-1].tolist()
            except ConnectorError:
                pass
            await asyncio.sleep(15)
