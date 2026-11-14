"""Connecteur Forex temps réel : paires de devises, gratuit et sans clé.

- Historique : Yahoo Finance (réponse en moins d'une seconde).
  Limites : 1 minute sur 7 jours, 5 à 30 minutes sur 60 jours, 1 heure sur 2 ans, 1 jour illimité.
- Temps réel : cotations publiques de Swissquote (prix acheteur, une lecture par seconde).
Le marché des changes est fermé du vendredi soir au dimanche soir : aucun prix ne bouge le week-end.
"""
from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator

import httpx
import numpy as np

from .base import Connector, ConnectorError, tf_ms
from .yahoo import YahooConnector

QUOTE_URL = "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/"
PAIRS = [
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    "EURGBP", "EURJPY", "GBPJPY", "EURCHF", "AUDJPY", "CHFJPY", "CADJPY", "NZDJPY",
    "EURAUD", "EURCAD", "EURNZD", "GBPAUD", "GBPCAD", "GBPCHF", "GBPNZD",
    "AUDCAD", "AUDCHF", "AUDNZD", "CADCHF", "NZDCAD", "NZDCHF",
]
NAMES = {"EUR": "Euro", "USD": "Dollar", "GBP": "Livre", "JPY": "Yen", "CHF": "Franc suisse",
         "AUD": "Dollar australien", "CAD": "Dollar canadien", "NZD": "Dollar néo-zélandais"}


class FxConnector(Connector):
    name = "fx"
    label = "Forex temps réel"
    markets = ("forex",)

    def __init__(self) -> None:
        self._yahoo = YahooConnector()
        self._client = httpx.AsyncClient(timeout=8)
        self._quotes: dict[str, tuple[float, float, float]] = {}  # symbole -> (lu à, prix, horodatage ms)

    async def symbols(self) -> list[dict]:
        return [{"symbol": p, "name": f"{NAMES[p[:3]]} / {NAMES[p[3:]]}", "market": "forex",
                 "precision": 3 if p.endswith("JPY") else 5} for p in PAIRS]

    def _check(self, symbol: str) -> str:
        symbol = symbol.upper()
        if symbol not in PAIRS:
            raise ConnectorError(f"Forex : paire inconnue « {symbol} ».")
        return symbol

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        return await self._yahoo.get_history(self._check(symbol) + "=X", tf, start_ms, end_ms)

    async def quote(self, symbol: str) -> tuple[float, float]:
        """Dernier prix acheteur et son horodatage (ms). Résultat gardé une seconde pour tous les graphiques."""
        symbol = self._check(symbol)
        hit = self._quotes.get(symbol)
        if hit and time.monotonic() - hit[0] < 1.0:
            return hit[1], hit[2]
        try:
            r = await self._client.get(f"{QUOTE_URL}{symbol[:3]}/{symbol[3:]}")
            r.raise_for_status()
            first = r.json()[0]
            price = float(first["spreadProfilePrices"][0]["bid"])
            ts = float(first["ts"])
        except Exception as exc:
            raise ConnectorError(f"Cotation indisponible pour {symbol} : {exc}") from exc
        self._quotes[symbol] = (time.monotonic(), price, ts)
        return price, ts

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        symbol = self._check(symbol)
        step = tf_ms(tf)
        bar: list[float] | None = None
        last_ts = 0.0
        # Amorce : la dernière bougie de l'historique, que les cotations vont ensuite prolonger.
        try:
            now = int(time.time() * 1000)
            rows = await self.get_history(symbol, tf, now - max(step * 3, 5 * 86400_000), now)
            if rows.size:
                bar = rows[-1].tolist()
        except ConnectorError:
            pass
        while True:
            try:
                price, ts = await self.quote(symbol)
            except ConnectorError:
                await asyncio.sleep(3)
                continue
            if ts > last_ts:  # nouvelle cotation (rien ne change quand le marché est fermé)
                last_ts = ts
                bucket = (ts - 4 * 86400_000) // step * step + 4 * 86400_000 if tf == "1w" else ts // step * step
                if bar is None or bucket > bar[0]:
                    bar = [bucket, price, price, price, price, 0.0]
                else:
                    bar[2], bar[3], bar[4] = max(bar[2], price), min(bar[3], price), price
                yield list(bar)
            await asyncio.sleep(1)
