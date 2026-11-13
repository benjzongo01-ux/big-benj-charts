"""Connecteur MetaTrader 5 (Exness, XM…) : forex, indices, matières premières, historique et temps réel.

Fonctionne uniquement sous Windows, avec le terminal MT5 installé et connecté à ton compte.
Installation du module : pip install MetaTrader5
Les données du broker restent à usage personnel (pas de redistribution).
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import AsyncIterator

import numpy as np

from .base import EMPTY, Connector, ConnectorError, clean

try:  # le module n'existe que sous Windows
    import MetaTrader5 as mt5  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - dépend de la machine
    mt5 = None


class MT5Connector(Connector):
    name = "mt5"
    label = "MetaTrader 5"
    markets = ("forex", "indices", "matieres")

    def __init__(self) -> None:
        self._ready = False
        self._lock = asyncio.Lock()

    def available(self) -> tuple[bool, str]:
        if mt5 is None:
            return False, "Module absent : lance « pip install MetaTrader5 » (Windows uniquement) et ouvre ton terminal MT5."
        return True, ""

    def _tf(self, tf: str) -> int:
        return {"1m": mt5.TIMEFRAME_M1, "5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15, "30m": mt5.TIMEFRAME_M30,
                "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4, "1d": mt5.TIMEFRAME_D1, "1w": mt5.TIMEFRAME_W1}[tf]

    def _connect(self) -> None:
        if self._ready and mt5.terminal_info() is not None:
            return
        kwargs: dict = {}
        if os.getenv("MT5_LOGIN"):
            kwargs = {"login": int(os.environ["MT5_LOGIN"]), "password": os.getenv("MT5_PASSWORD", ""),
                      "server": os.getenv("MT5_SERVER", "")}
        if not mt5.initialize(**kwargs):
            raise ConnectorError(f"MT5 : connexion impossible {mt5.last_error()}. Ouvre le terminal MT5 et connecte ton compte.")
        self._ready = True

    @staticmethod
    def _rows(rates) -> np.ndarray:
        if rates is None or len(rates) == 0:
            return EMPTY
        out = np.empty((len(rates), 6), dtype=np.float64)
        out[:, 0] = rates["time"].astype(np.float64) * 1000
        out[:, 1], out[:, 2], out[:, 3], out[:, 4] = rates["open"], rates["high"], rates["low"], rates["close"]
        out[:, 5] = rates["tick_volume"]
        return out

    async def _call(self, fn, *args):
        ok, why = self.available()
        if not ok:
            raise ConnectorError(why)
        async with self._lock:  # l'API MT5 n'accepte qu'un appel à la fois
            def run():
                self._connect()
                return fn(*args)
            return await asyncio.to_thread(run)

    async def symbols(self) -> list[dict]:
        ok, _ = self.available()
        if not ok:
            return []
        try:
            infos = await self._call(mt5.symbols_get)
        except ConnectorError:
            return []
        out = []
        for s in infos or []:
            if not s.visible:
                continue
            path = (s.path or "").lower()
            market = "indices" if "ind" in path else "matieres" if any(k in path for k in ("metal", "energ", "commod")) \
                else "crypto" if "crypto" in path else "forex"
            out.append({"symbol": s.name, "name": s.description or s.name, "market": market, "precision": s.digits})
        return out

    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        start = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
        end = datetime.fromtimestamp(end_ms / 1000, timezone.utc)

        def fetch():
            mt5.symbol_select(symbol, True)
            return mt5.copy_rates_range(symbol, self._tf(tf), start, end)

        rates = await self._call(fetch)
        if rates is None:
            raise ConnectorError(f"MT5 : pas de données pour {symbol} {mt5.last_error()}.")
        return clean(self._rows(rates))

    async def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        last: list[float] | None = None
        while True:
            try:
                rates = await self._call(mt5.copy_rates_from_pos, symbol, self._tf(tf), 0, 1)
                rows = self._rows(rates)
                if rows.size:
                    bar = rows[-1].tolist()
                    if bar != last:
                        last = bar
                        yield bar
            except ConnectorError:
                await asyncio.sleep(3)
            await asyncio.sleep(0.25)
