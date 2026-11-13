"""Connecteur Binance : crypto, historique (klines REST) et temps réel (WebSocket). Gratuit, sans clé."""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import httpx
import numpy as np
import websockets

from .base import EMPTY, Connector, ConnectorError, clean, tf_ms

# Deux adresses officielles : la seconde (données de marché seules) prend le relais
# là où api.binance.com est bloqué ou en panne.
REST_HOSTS = ("https://api.binance.com", "https://data-api.binance.vision")
WS_HOSTS = ("wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws")
INTERVALS = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w"}

POPULAR = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT",
    "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT", "MATICUSDT", "ATOMUSDT", "NEARUSDT", "SUIUSDT",
]


class BinanceConnector(Connector):
    name = "binance"
    label = "Binance"
    markets = ("crypto",)

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=20, limits=httpx.Limits(max_connections=8))
        self._symbols: list[dict] | None = None

    async def _get(self, path: str, params: dict) -> object:
        last: Exception | None = None
        for host in REST_HOSTS:
            try:
                r = await self._client.get(host + path, params=params)
                if r.status_code == 429:
                    raise ConnectorError("Binance : limite de requêtes atteinte, réessaie dans une minute.")
                if r.status_code == 400:
                    raise ConnectorError(f"Binance : symbole ou paramètre invalide ({r.text[:120]}).")
                r.raise_for_status()
                return r.json()
            except ConnectorError:
                raise
            except Exception as exc:  # hôte bloqué ou connexion perdue : on essaie le suivant
                last = exc
        raise ConnectorError(f"Binance injoignable : {last}")

    async def symbols(self) -> list[dict]:
        if self._symbols is None:
            try:
                info = await self._get("/api/v3/exchangeInfo", {"permissions": "SPOT"})
                out = []
                for s in info["symbols"]:  # type: ignore[index]
                    if s.get("status") != "TRADING" or s.get("quoteAsset") not in ("USDT", "USDC", "BTC", "EUR"):
                        continue
                    tick = next((f["tickSize"] for f in s["filters"] if f["filterType"] == "PRICE_FILTER"), "0.01")
                    precision = max(0, len(tick.rstrip("0").split(".")[1]) if "." in tick.rstrip("0") else 0)
                    out.append({"symbol": s["symbol"], "name": f'{s["baseAsset"]} / {s["quoteAsset"]}',
                                "market": "crypto", "precision": precision})
                rank = {s: i for i, s in enumerate(POPULAR)}
                out.sort(key=lambda x: (rank.get(x["symbol"], 999), x["symbol"]))
                self._symbols = out
            except ConnectorError:
                return [{"symbol": s, "name": s, "market": "crypto", "precision": 2} for s in POPULAR]
        return self._symbols

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        step = tf_ms(tf)
        # Les pages de 1000 bougies sont téléchargées en parallèle (6 à la fois) pour aller vite.
        pages = [(a, min(end_ms, a + 1000 * step - 1)) for a in range(start_ms // step * step, end_ms + 1, 1000 * step)]
        sem = asyncio.Semaphore(6)

        async def page(a: int, b: int) -> np.ndarray:
            async with sem:
                data = await self._get("/api/v3/klines", {
                    "symbol": symbol.upper(), "interval": INTERVALS[tf], "startTime": a, "endTime": b, "limit": 1000})
            if not data:
                return EMPTY
            return np.array([[k[0], k[1], k[2], k[3], k[4], k[5]] for k in data], dtype=np.float64)  # type: ignore[union-attr]

        chunks = [c for c in await asyncio.gather(*(page(a, b) for a, b in pages)) if c.size]
        return clean(np.vstack(chunks)) if chunks else EMPTY

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        channel = f"{symbol.lower()}@kline_{INTERVALS[tf]}"
        attempt = 0
        while True:
            host = WS_HOSTS[attempt % len(WS_HOSTS)]
            try:
                async with websockets.connect(f"{host}/{channel}", ping_interval=20, open_timeout=10) as ws:
                    attempt = 0
                    async for raw in ws:
                        k = json.loads(raw).get("k")
                        if k:
                            yield [float(k["t"]), float(k["o"]), float(k["h"]), float(k["l"]), float(k["c"]), float(k["v"])]
            except asyncio.CancelledError:
                raise
            except Exception:
                # Connexion perdue : on se reconnecte avec une attente progressive.
                attempt += 1
                await asyncio.sleep(min(10, attempt))
