"""Connecteur Dukascopy : historique gratuit forex, or, indices et pétrole (fichiers .bi5 publics).

Trois niveaux de fichiers sont utilisés pour aller vite :
- un fichier par jour  (bougies 1 minute)  pour 1m à 30m ;
- un fichier par mois  (bougies 1 heure)   pour 1h et 4h ;
- un fichier par année (bougies 1 jour)    pour 1d et 1w.
Pas de flux temps réel officiel : le « stream » relit simplement la dernière bougie disponible.
"""
from __future__ import annotations

import asyncio
import lzma
import struct
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

import httpx
import numpy as np

from .base import EMPTY, Connector, ConnectorError, clean, resample, tf_ms

BASE = "https://datafeed.dukascopy.com/datafeed"

# symbole -> (nom, marché, diviseur de prix, décimales)
INSTRUMENTS: dict[str, tuple[str, str, float, int]] = {
    "EURUSD": ("Euro / Dollar", "forex", 1e5, 5),
    "GBPUSD": ("Livre / Dollar", "forex", 1e5, 5),
    "USDJPY": ("Dollar / Yen", "forex", 1e3, 3),
    "USDCHF": ("Dollar / Franc suisse", "forex", 1e5, 5),
    "AUDUSD": ("Dollar australien / Dollar", "forex", 1e5, 5),
    "USDCAD": ("Dollar / Dollar canadien", "forex", 1e5, 5),
    "NZDUSD": ("Dollar néo-zélandais / Dollar", "forex", 1e5, 5),
    "EURGBP": ("Euro / Livre", "forex", 1e5, 5),
    "EURJPY": ("Euro / Yen", "forex", 1e3, 3),
    "GBPJPY": ("Livre / Yen", "forex", 1e3, 3),
    "EURCHF": ("Euro / Franc suisse", "forex", 1e5, 5),
    "AUDJPY": ("Dollar australien / Yen", "forex", 1e3, 3),
    "XAUUSD": ("Or / Dollar", "matieres", 1e3, 2),
    "XAGUSD": ("Argent / Dollar", "matieres", 1e3, 3),
    "BRENTCMDUSD": ("Pétrole Brent", "matieres", 1e3, 2),
    "LIGHTCMDUSD": ("Pétrole WTI", "matieres", 1e3, 2),
}

RECORD = struct.Struct(">5if")  # décalage (s), open, close, low, high, volume


class DukascopyConnector(Connector):
    name = "dukascopy"
    label = "Dukascopy (lent)"
    markets = ("forex", "matieres")

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=4),
                                         headers={"User-Agent": "Mozilla/5.0"})
        # Dukascopy coupe les clients trop gourmands : 4 téléchargements à la fois, pas plus.
        self._sem = asyncio.Semaphore(4)
        self._failures = 0
        self._last_error = ""

    async def symbols(self) -> list[dict]:
        return [{"symbol": s, "name": n, "market": m, "precision": p} for s, (n, m, _, p) in INSTRUMENTS.items()]

    async def _file(self, url: str, base_ms: int, divisor: float, tries: int = 3) -> np.ndarray:
        """Télécharge et décode un fichier .bi5 (LZMA, enregistrements de 24 octets)."""
        async with self._sem:
            for attempt in range(tries):
                try:
                    r = await self._client.get(url)
                    if r.status_code == 404 or not r.content:
                        return EMPTY  # jour férié, week-end ou période pas encore publiée
                    r.raise_for_status()
                    break
                except httpx.HTTPError as exc:
                    if attempt == tries - 1:
                        # Fichier indisponible (souvent la période en cours) : on continue avec le reste.
                        self._failures += 1
                        self._last_error = str(exc)[:160]
                        return EMPTY
                    await asyncio.sleep(1 + attempt)
        try:
            raw = lzma.decompress(r.content)
        except lzma.LZMAError:
            return EMPTY
        n = len(raw) // RECORD.size
        if n == 0:
            return EMPTY
        rec = np.frombuffer(raw[: n * RECORD.size], dtype=np.dtype([
            ("t", ">i4"), ("o", ">i4"), ("c", ">i4"), ("l", ">i4"), ("h", ">i4"), ("v", ">f4")]))
        out = np.empty((n, 6), dtype=np.float64)
        out[:, 0] = base_ms + rec["t"].astype(np.int64) * 1000
        out[:, 1] = rec["o"] / divisor
        out[:, 2] = rec["h"] / divisor
        out[:, 3] = rec["l"] / divisor
        out[:, 4] = rec["c"] / divisor
        out[:, 5] = rec["v"]
        # Les bougies sans échange (volume nul, week-end) sont retirées.
        return out[out[:, 5] > 0]

    async def _minutes(self, symbol: str, divisor: float, start: datetime, end: datetime) -> np.ndarray:
        """Bougies 1 minute, un fichier par jour (le samedi, marché fermé, est sauté)."""
        tasks = []
        day = start.replace(hour=0, minute=0, second=0, microsecond=0)
        while day <= end:
            if day.weekday() != 5:
                tasks.append(self._file(
                    f"{BASE}/{symbol}/{day.year}/{day.month - 1:02d}/{day.day:02d}/BID_candles_min_1.bi5",
                    int(day.timestamp() * 1000), divisor))
            day += timedelta(days=1)
        parts = [p for p in await asyncio.gather(*tasks) if p.size]
        return clean(np.vstack(parts)) if parts else EMPTY

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        symbol = symbol.upper()
        if symbol not in INSTRUMENTS:
            raise ConnectorError(f"Dukascopy : symbole inconnu « {symbol} ».")
        divisor = INSTRUMENTS[symbol][2]
        start = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
        end = min(datetime.fromtimestamp(end_ms / 1000, timezone.utc), datetime.now(timezone.utc))
        self._failures = 0
        if tf in ("1m", "5m", "15m", "30m"):
            # Au-delà de 400 jours en minutes, on ne garde que la partie la plus récente.
            rows = await self._minutes(symbol, divisor, max(start, end - timedelta(days=400)), end)
        else:
            base_tf = "1d" if tf in ("1d", "1w") else "1h"
            tasks = []
            if base_tf == "1d":
                for year in range(start.year, end.year + 1):
                    base = int(datetime(year, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
                    tasks.append(self._file(f"{BASE}/{symbol}/{year}/BID_candles_day_1.bi5", base, divisor, tries=1))
            else:
                y, m = start.year, start.month
                while (y, m) <= (end.year, end.month):
                    base = int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp() * 1000)
                    tasks.append(self._file(f"{BASE}/{symbol}/{y}/{m - 1:02d}/BID_candles_hour_1.bi5", base, divisor, tries=1))
                    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
            parts = [p for p in await asyncio.gather(*tasks) if p.size]
            if self._failures:
                # Les fichiers regroupés (heure / jour) sont souvent indisponibles : on reconstruit
                # la partie récente à partir des fichiers minute, plus fiables mais plus longs à charger.
                days = 150 if base_tf == "1d" else 45
                minutes = await self._minutes(symbol, divisor, max(start, end - timedelta(days=days)), end)
                if minutes.size:
                    parts.append(resample(minutes, base_tf))
            rows = clean(np.vstack(parts)) if parts else EMPTY
        if rows.size == 0:
            if self._failures:
                raise ConnectorError(f"Dukascopy injoignable pour le moment ({self._last_error}). Réessaie dans quelques minutes.")
            return EMPTY
        if tf not in ("1m", "1h", "1d"):
            rows = resample(rows, tf)
        return rows[(rows[:, 0] >= start_ms - tf_ms(tf)) & (rows[:, 0] <= end_ms)]

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        # Dukascopy publie avec retard : on relit la fin de l'historique toutes les 30 secondes.
        step = tf_ms(tf)
        while True:
            now = int(datetime.now(timezone.utc).timestamp() * 1000)
            try:
                rows = await self.get_history(symbol, tf, now - max(step * 3, 3 * 86400_000), now)
                if rows.size:
                    yield rows[-1].tolist()
            except ConnectorError:
                pass
            await asyncio.sleep(30)
