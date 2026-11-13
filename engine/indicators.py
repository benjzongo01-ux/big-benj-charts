"""Indicateurs techniques vectorisés (numpy). Tous sont causaux : la valeur à l'indice i
n'utilise que les bougies 0..i, jamais le futur."""
from __future__ import annotations

import numpy as np


def sma(x: np.ndarray, period: int) -> np.ndarray:
    """Moyenne mobile simple."""
    out = np.full(len(x), np.nan)
    if period <= 0 or len(x) < period:
        return out
    csum = np.cumsum(np.insert(x.astype(np.float64), 0, 0.0))
    out[period - 1:] = (csum[period:] - csum[:-period]) / period
    return out


def ema(x: np.ndarray, period: int) -> np.ndarray:
    """Moyenne mobile exponentielle (amorcée par une moyenne simple)."""
    out = np.full(len(x), np.nan)
    if period <= 0 or len(x) < period:
        return out
    alpha = 2.0 / (period + 1)
    prev = float(np.mean(x[:period]))
    out[period - 1] = prev
    for i in range(period, len(x)):
        prev = alpha * float(x[i]) + (1 - alpha) * prev
        out[i] = prev
    return out


def rma(x: np.ndarray, period: int) -> np.ndarray:
    """Moyenne de Wilder (utilisée par le RSI et l'ATR)."""
    out = np.full(len(x), np.nan)
    if period <= 0 or len(x) < period:
        return out
    prev = float(np.mean(x[:period]))
    out[period - 1] = prev
    for i in range(period, len(x)):
        prev = (prev * (period - 1) + float(x[i])) / period
        out[i] = prev
    return out


def rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    """Relative Strength Index."""
    out = np.full(len(close), np.nan)
    if len(close) <= period:
        return out
    delta = np.diff(close)
    gain = rma(np.maximum(delta, 0.0), period)
    loss = rma(np.maximum(-delta, 0.0), period)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = gain / loss
    out[1:] = np.where(loss == 0, 100.0, 100.0 - 100.0 / (1.0 + rs))
    return out


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Average True Range."""
    prev = np.r_[close[0], close[:-1]]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev), np.abs(low - prev)))
    return rma(tr, period)


def rolling_std(x: np.ndarray, period: int) -> np.ndarray:
    """Écart-type glissant."""
    out = np.full(len(x), np.nan)
    if period <= 1 or len(x) < period:
        return out
    win = np.lib.stride_tricks.sliding_window_view(x.astype(np.float64), period)
    out[period - 1:] = win.std(axis=1)
    return out


def bollinger(close: np.ndarray, period: int = 20, k: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bandes de Bollinger : (milieu, haute, basse)."""
    mid = sma(close, period)
    sd = rolling_std(close, period)
    return mid, mid + k * sd, mid - k * sd


def rolling_max(x: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if period <= 0 or len(x) < period:
        return out
    out[period - 1:] = np.lib.stride_tricks.sliding_window_view(x, period).max(axis=1)
    return out


def rolling_min(x: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if period <= 0 or len(x) < period:
        return out
    out[period - 1:] = np.lib.stride_tricks.sliding_window_view(x, period).min(axis=1)
    return out


def macd(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[np.ndarray, np.ndarray]:
    """MACD : (ligne MACD, ligne de signal)."""
    line = ema(close, fast) - ema(close, slow)
    sig = np.full(len(close), np.nan)
    valid = np.flatnonzero(~np.isnan(line))
    if len(valid) >= signal:
        sig[valid[0]:] = ema(line[valid[0]:], signal)
    return line, sig
