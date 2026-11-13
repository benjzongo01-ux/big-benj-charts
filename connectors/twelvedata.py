"""Connecteur Twelve Data (offre gratuite : 800 crédits par jour). Nécessite TWELVEDATA_API_KEY dans .env."""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import AsyncIterator

import httpx
import numpy as np

from .base import EMPTY, Connector, ConnectorError, clean, tf_ms

URL = "https://api.twelvedata.com/time_series"
INTERVALS = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week"}
SYMBOLS = [("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "Nvidia"), ("TSLA", "Tesla"), ("AMZN", "Amazon"),
           ("GOOGL", "Alphabet"), ("META", "Meta"), ("SPY", "ETF S&P 500"), ("QQQ", "ETF Nasdaq 100")]


class TwelveDataConnector(Connector):
    name = "twelvedata"
    label = "Twelve Data"
    markets = ("actions",)

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=20)

    def available(self) -> tuple[bool, str]:
        if not os.getenv("TWELVEDATA_API_KEY"):
            return False, "Ajoute TWELVEDATA_API_KEY dans le fichier .env (clé gratuite sur twelvedata.com)."
        return True, ""

    async def symbols(self) -> list[dict]:
        return [{"symbol": s, "name": n, "market": "actions", "precision": 2} for s, n in SYMBOLS]

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        ok, why = self.available()
        if not ok:
            raise ConnectorError(why)
        fmt = "%Y-%m-%d %H:%M:%S"
        try:
            r = await self._client.get(URL, params={
                "symbol": symbol, "interval": INTERVALS[tf], "timezone": "UTC", "outputsize": 5000, "order": "ASC",
                "start_date": datetime.fromtimestamp(start_ms / 1000, timezone.utc).strftime(fmt),
                "end_date": datetime.fromtimestamp(end_ms / 1000, timezone.utc).strftime(fmt),
                "apikey": os.environ["TWELVEDATA_API_KEY"]})
            data = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ConnectorError(f"Twelve Data injoignable : {exc}") from exc
        if data.get("status") == "error":
            if data.get("code") == 429:
                raise ConnectorError("Twelve Data : quota gratuit atteint (800 crédits par jour).")
            if data.get("code") == 400 and "No data" in str(data.get("message")):
                return EMPTY
            raise ConnectorError(f"Twelve Data : {data.get('message')}")
        rows = []
        for v in data.get("values", []):
            text = v["datetime"]
            dt = datetime.strptime(text, fmt if " " in text else "%Y-%m-%d").replace(tzinfo=timezone.utc)
            rows.append([dt.timestamp() * 1000, v["open"], v["high"], v["low"], v["close"], v.get("volume") or 0])
        return clean(np.array(rows, dtype=np.float64)) if rows else EMPTY

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        # Une requête par minute pour ménager le quota gratuit.
        step = tf_ms(tf)
        while True:
            now = int(time.time() * 1000)
            try:
                rows = await self.get_history(symbol, tf, now - max(step * 5, 5 * 86400_000), now)
                if rows.size:
                    yield rows[-1].tolist()
            except ConnectorError:
                pass
            await asyncio.sleep(60)
