"""Interface commune à toutes les sources de données.

Chaque connecteur renvoie les bougies dans le format unique :
tableau numpy (n, 6) en float64 -> timestamp (ms UTC), open, high, low, close, volume.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator

import numpy as np

# Durée de chaque unité de temps, en secondes.
TF_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
}

EMPTY = np.empty((0, 6), dtype=np.float64)


class ConnectorError(Exception):
    """Erreur lisible renvoyée à l'utilisateur (connexion perdue, quota atteint, symbole inconnu…)."""


def tf_ms(tf: str) -> int:
    """Durée d'une unité de temps en millisecondes."""
    if tf not in TF_SECONDS:
        raise ConnectorError(f"Unité de temps inconnue : {tf}")
    return TF_SECONDS[tf] * 1000


def clean(rows: np.ndarray) -> np.ndarray:
    """Trie par date, supprime les doublons et les lignes invalides."""
    if rows.size == 0:
        return EMPTY
    rows = np.asarray(rows, dtype=np.float64).reshape(-1, 6)
    rows = rows[np.isfinite(rows[:, :5]).all(axis=1)]
    if rows.size == 0:
        return EMPTY
    # On garde la dernière version de chaque bougie (la plus à jour).
    order = np.argsort(rows[:, 0], kind="stable")
    rows = rows[order]
    keep = np.ones(len(rows), dtype=bool)
    keep[:-1] = rows[1:, 0] != rows[:-1, 0]
    return np.ascontiguousarray(rows[keep])


def resample(rows: np.ndarray, tf: str) -> np.ndarray:
    """Regroupe des bougies fines en bougies d'une unité de temps plus grande (calcul vectorisé)."""
    if rows.size == 0:
        return EMPTY
    step = tf_ms(tf)
    ts = rows[:, 0].astype(np.int64)
    if tf == "1w":
        # Les semaines commencent le lundi (le 1er janvier 1970 était un jeudi).
        bucket = (ts - 4 * 86400_000) // step * step + 4 * 86400_000
    else:
        bucket = ts // step * step
    starts = np.flatnonzero(np.r_[True, bucket[1:] != bucket[:-1]])
    out = np.empty((len(starts), 6), dtype=np.float64)
    out[:, 0] = bucket[starts]
    out[:, 1] = rows[starts, 1]
    out[:, 2] = np.maximum.reduceat(rows[:, 2], starts)
    out[:, 3] = np.minimum.reduceat(rows[:, 3], starts)
    ends = np.r_[starts[1:], len(rows)] - 1
    out[:, 4] = rows[ends, 4]
    out[:, 5] = np.add.reduceat(rows[:, 5], starts)
    return out


class Connector(ABC):
    """Contrat que chaque source de données doit respecter."""

    #: identifiant technique (ex. « binance »)
    name: str = ""
    #: nom affiché dans l'interface
    label: str = ""
    #: marchés couverts
    markets: tuple[str, ...] = ()

    def available(self) -> tuple[bool, str]:
        """Indique si la source est utilisable sur cette machine, sinon pourquoi."""
        return True, ""

    @abstractmethod
    async def symbols(self) -> list[dict]:
        """Liste des symboles : [{symbol, name, market, precision}]."""

    @abstractmethod
    async def get_history(self, symbol: str, tf: str, start_ms: int, end_ms: int) -> np.ndarray:
        """Bougies entre start_ms et end_ms (inclus), au format unique."""

    @abstractmethod
    def stream(self, symbol: str, tf: str) -> AsyncIterator[list[float]]:
        """Flux temps réel : renvoie la bougie en cours à chaque mise à jour."""
