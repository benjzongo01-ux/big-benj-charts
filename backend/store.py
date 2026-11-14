"""Stockage des bougies : un fichier binaire en colonnes (numpy) par utilisateur / source / symbole / unité de temps.

Bien plus rapide qu'une table SQL pour des millions de bougies : lecture directe en mémoire,
puis découpe par recherche dichotomique. Un cache mémoire évite de relire le disque.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from pathlib import Path

import numpy as np

from connectors import ConnectorError, clean, get_connector, tf_ms
from connectors.base import EMPTY

from .config import CACHE_MB, DATA_DIR, SHARED_CANDLES

CANDLE_DIR = DATA_DIR / "candles"
_SAFE = re.compile(r"[^A-Za-z0-9_.\-]")


class CandleStore:
    """Lecture, fusion et écriture des séries de bougies."""

    def __init__(self) -> None:
        self._cache: dict[tuple, np.ndarray] = {}
        self._meta: dict[tuple, dict] = {}
        self._lock = threading.Lock()
        self._locks: dict[tuple, asyncio.Lock] = {}

    def _path(self, key: tuple) -> Path:
        user_id, source, symbol, tf = key
        folder = CANDLE_DIR / ("user_" + _SAFE.sub("_", str(user_id))) / _SAFE.sub("_", source)
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"{_SAFE.sub('_', symbol)}_{tf}.npy"

    def load(self, key: tuple) -> tuple[np.ndarray, dict]:
        """Renvoie (bougies, méta). Méta = plage déjà demandée à la source {start, end}."""
        with self._lock:
            if key in self._cache:
                return self._cache[key], self._meta[key]
            path = self._path(key)
            rows, meta = EMPTY, {}
            if path.exists():
                try:
                    rows = np.load(path)
                    meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
                except Exception:
                    rows, meta = EMPTY, {}  # fichier abîmé : il sera retéléchargé
            self._cache[key], self._meta[key] = rows, meta
            self._trim(key)
            return rows, meta

    def save(self, key: tuple, rows: np.ndarray, meta: dict) -> None:
        path = self._path(key)
        tmp = path.with_suffix(".tmp.npy")
        np.save(tmp, rows)
        tmp.replace(path)
        path.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
        with self._lock:
            self._cache.pop(key, None)  # réinséré en dernier : c'est la série la plus récemment utilisée
            self._cache[key], self._meta[key] = rows, meta
            self._trim(key)

    def _trim(self, keep: tuple) -> None:
        """Limite la mémoire : les séries les plus anciennes sortent du cache (elles restent sur disque)."""
        limit = CACHE_MB * 1024 * 1024
        total = sum(a.nbytes for a in self._cache.values())
        for key in list(self._cache):
            if total <= limit:
                break
            if key != keep:
                total -= self._cache.pop(key).nbytes
                self._meta.pop(key, None)

    def lock(self, key: tuple) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]


STORE = CandleStore()


async def get_candles(user_id: int | str, source: str, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
    """Bougies de la plage demandée. Ne télécharge que ce qui manque (avant et après ce qui est stocké)."""
    connector = get_connector(source)
    step = tf_ms(tf)
    now = int(time.time() * 1000)
    end_ms = min(end_ms, now)
    if start_ms > end_ms:
        return EMPTY
    key = (0 if SHARED_CANDLES else user_id, source, symbol, tf)
    async with STORE.lock(key):
        rows, meta = STORE.load(key)
        cov_start, cov_end = meta.get("start"), meta.get("end")
        gaps: list[tuple[int, int]] = []
        if cov_start is None:
            gaps.append((start_ms, end_ms))
        else:
            if start_ms < cov_start:
                gaps.append((start_ms, cov_start))
            # La dernière bougie stockée était peut-être en cours de formation : on la relit.
            if end_ms > cov_end + min(step, 5_000) or (cov_end >= now - step and end_ms >= cov_end and now - meta.get("at", 0) > 5_000):
                gaps.append((max(start_ms, cov_end - 2 * step) if cov_end >= start_ms else cov_end - 2 * step, end_ms))
        if gaps:
            try:
                parts = [await connector.get_history(symbol, tf, a, b) for a, b in gaps]
            except ConnectorError:
                if rows.size == 0:
                    raise
                parts = []  # source indisponible : on sert ce qu'on a déjà
            if parts:
                merged = clean(np.vstack([rows, *parts])) if any(p.size for p in parts) else rows
                meta = {"start": min(start_ms, cov_start) if cov_start is not None else start_ms,
                        "end": max(end_ms, cov_end) if cov_end is not None else end_ms,
                        "at": int(time.time() * 1000)}
                await asyncio.to_thread(STORE.save, key, merged, meta)
                rows = merged
    if rows.size == 0:
        return EMPTY
    lo = int(np.searchsorted(rows[:, 0], start_ms, side="left"))
    hi = int(np.searchsorted(rows[:, 0], end_ms, side="right"))
    return rows[lo:hi]
