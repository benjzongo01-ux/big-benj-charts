"""Stratégies prêtes à l'emploi + exécution d'une stratégie Python personnalisée.

Une stratégie renvoie un tableau de positions souhaitées par bougie : 1 (long), -1 (short), 0 (hors marché).
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from . import indicators as ind

Strategy = Callable[[np.ndarray, dict], np.ndarray]


def _hold(entries_long: np.ndarray, entries_short: np.ndarray, exits: np.ndarray | None = None) -> np.ndarray:
    """Transforme des événements d'entrée/sortie en position tenue jusqu'au prochain événement."""
    state = np.zeros(len(entries_long), dtype=np.float64)
    state[:] = np.nan
    state[entries_long] = 1
    state[entries_short] = -1
    if exits is not None:
        state[exits & ~entries_long & ~entries_short] = 0
    # Propagation de la dernière valeur connue (forward fill vectorisé).
    idx = np.where(~np.isnan(state), np.arange(len(state)), 0)
    np.maximum.accumulate(idx, out=idx)
    out = state[idx]
    return np.nan_to_num(out)


def sma_cross(c: np.ndarray, p: dict) -> np.ndarray:
    fast, slow = ind.sma(c[:, 4], int(p.get("rapide", 20))), ind.sma(c[:, 4], int(p.get("lente", 50)))
    sig = np.where(fast > slow, 1.0, -1.0)
    sig[np.isnan(fast) | np.isnan(slow)] = 0
    return sig


def ema_cross(c: np.ndarray, p: dict) -> np.ndarray:
    fast, slow = ind.ema(c[:, 4], int(p.get("rapide", 12))), ind.ema(c[:, 4], int(p.get("lente", 26)))
    sig = np.where(fast > slow, 1.0, -1.0)
    sig[np.isnan(fast) | np.isnan(slow)] = 0
    return sig


def rsi_reversal(c: np.ndarray, p: dict) -> np.ndarray:
    r = ind.rsi(c[:, 4], int(p.get("periode", 14)))
    low, high = float(p.get("survente", 30)), float(p.get("surachat", 70))
    prev = np.r_[np.nan, r[:-1]]
    return _hold((prev < low) & (r >= low), (prev > high) & (r <= high))


def bollinger_reversion(c: np.ndarray, p: dict) -> np.ndarray:
    close = c[:, 4]
    mid, up, dn = ind.bollinger(close, int(p.get("periode", 20)), float(p.get("ecarts", 2.0)))
    prev = np.r_[np.nan, close[:-1]]
    pmid = np.r_[np.nan, mid[:-1]]
    exits = ((prev < pmid) & (close >= mid)) | ((prev > pmid) & (close <= mid))
    return _hold(close < dn, close > up, exits)


def donchian_breakout(c: np.ndarray, p: dict) -> np.ndarray:
    n = int(p.get("periode", 20))
    # Canal calculé sur les bougies précédentes uniquement (décalage d'une bougie).
    up = np.r_[np.nan, ind.rolling_max(c[:, 2], n)[:-1]]
    dn = np.r_[np.nan, ind.rolling_min(c[:, 3], n)[:-1]]
    return _hold(c[:, 4] > up, c[:, 4] < dn)


def macd_cross(c: np.ndarray, p: dict) -> np.ndarray:
    line, sig = ind.macd(c[:, 4], int(p.get("rapide", 12)), int(p.get("lente", 26)), int(p.get("signal", 9)))
    out = np.where(line > sig, 1.0, -1.0)
    out[np.isnan(line) | np.isnan(sig)] = 0
    return out


BUILTIN: dict[str, dict] = {
    "sma_cross": {"label": "Croisement de moyennes mobiles", "fn": sma_cross, "params": {"rapide": 20, "lente": 50}},
    "ema_cross": {"label": "Croisement de moyennes exponentielles", "fn": ema_cross, "params": {"rapide": 12, "lente": 26}},
    "rsi_reversal": {"label": "Retournement RSI", "fn": rsi_reversal, "params": {"periode": 14, "survente": 30, "surachat": 70}},
    "bollinger_reversion": {"label": "Retour à la moyenne Bollinger", "fn": bollinger_reversion, "params": {"periode": 20, "ecarts": 2.0}},
    "donchian_breakout": {"label": "Cassure de canal Donchian", "fn": donchian_breakout, "params": {"periode": 20}},
    "macd_cross": {"label": "Croisement MACD", "fn": macd_cross, "params": {"rapide": 12, "lente": 26, "signal": 9}},
}

TEMPLATE = '''# Stratégie personnalisée.
# Variables disponibles : open, high, low, close, volume (tableaux numpy), params (dict),
# np (numpy) et ind (sma, ema, rsi, atr, bollinger, macd, rolling_max, rolling_min).
# Renvoie une position par bougie : 1 = achat, -1 = vente, 0 = hors marché.
# Le moteur exécute chaque décision à l'ouverture de la bougie suivante.

def strategy(open, high, low, close, volume, params):
    rapide = ind.ema(close, 9)
    lente = ind.ema(close, 21)
    tendance = ind.sma(close, 200)
    signal = np.zeros(len(close))
    signal[(rapide > lente) & (close > tendance)] = 1
    signal[(rapide < lente) & (close < tendance)] = -1
    return signal
'''


def run_custom(code: str, candles: np.ndarray, params: dict) -> np.ndarray:
    """Exécute une stratégie Python écrite par l'utilisateur (usage local uniquement)."""
    scope: dict = {"np": np, "ind": ind}
    try:
        exec(compile(code, "<strategie>", "exec"), scope)  # noqa: S102 - activé seulement en local
    except Exception as exc:
        raise ValueError(f"Erreur dans le code de la stratégie : {exc}") from exc
    fn = scope.get("strategy")
    if not callable(fn):
        raise ValueError("Le code doit définir une fonction strategy(open, high, low, close, volume, params).")
    try:
        out = np.asarray(fn(candles[:, 1], candles[:, 2], candles[:, 3], candles[:, 4], candles[:, 5], params), dtype=np.float64)
    except Exception as exc:
        raise ValueError(f"Erreur pendant l'exécution de la stratégie : {exc}") from exc
    if out.shape != (len(candles),):
        raise ValueError("La stratégie doit renvoyer une valeur par bougie.")
    return out
