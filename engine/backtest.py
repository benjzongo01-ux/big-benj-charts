"""Moteur de backtest réaliste.

Règles anti-biais :
- le signal calculé à la clôture de la bougie i est exécuté à l'OUVERTURE de la bougie i+1 ;
- stop loss et take profit sont testés sur le haut/bas de chaque bougie ; si les deux sont
  touchés dans la même bougie, on retient le stop (hypothèse prudente) ;
- spread, slippage et commissions sont appliqués à chaque entrée et à chaque sortie.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

import numpy as np

BARS_PER_YEAR = {"1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760, "2h": 4380, "4h": 2190, "1d": 365, "1w": 52}


@dataclass
class BacktestConfig:
    """Paramètres d'exécution d'un backtest."""

    capital: float = 10_000.0      # capital de départ
    position_pct: float = 100.0    # part du capital engagée par trade (si pas de stop)
    risk_pct: float = 0.0          # risque par trade en % du capital (utilisé avec sl_pct)
    sl_pct: float = 0.0            # stop loss en % du prix d'entrée (0 = aucun)
    tp_pct: float = 0.0            # take profit en % du prix d'entrée (0 = aucun)
    spread: float = 0.0            # écart achat/vente, en unités de prix
    slippage: float = 0.0          # glissement par exécution, en unités de prix
    commission_pct: float = 0.0    # commission par exécution, en % du montant
    allow_short: bool = True       # autoriser les ventes à découvert


@dataclass
class Trade:
    side: int            # 1 = achat, -1 = vente
    entry_time: float
    entry_price: float
    exit_time: float
    exit_price: float
    size: float
    pnl: float           # résultat net, frais inclus
    fees: float
    reason: str          # signal, stop, objectif, fin


def run_backtest(candles: np.ndarray, signal: np.ndarray, cfg: BacktestConfig, tf: str = "1h",
                 progress: Callable[[float], None] | None = None) -> dict:
    """Exécute un backtest. `signal[i]` vaut 1 (long), -1 (short) ou 0 (hors marché)."""
    n = len(candles)
    if n < 2:
        raise ValueError("Pas assez de bougies pour lancer un backtest.")
    if len(signal) != n:
        raise ValueError("Le signal doit avoir une valeur par bougie.")
    ts, op, hi, lo, cl = (candles[:, k].tolist() for k in range(5))
    sig = np.nan_to_num(np.asarray(signal, dtype=np.float64)).clip(-1, 1).round().astype(np.int8).tolist()
    half = cfg.spread / 2.0 + cfg.slippage
    fee_rate = cfg.commission_pct / 100.0

    cash = cfg.capital
    pos = 0            # position courante : 1, -1 ou 0
    size = entry = stop = target = entry_fee = 0.0
    entry_time = 0.0
    trades: list[Trade] = []
    equity = [0.0] * n
    equity[0] = cash
    tick = max(1, n // 50)

    def close_position(price: float, when: float, reason: str) -> None:
        nonlocal cash, pos
        fill = price - half if pos == 1 else price + half  # sortie au mauvais côté du spread
        fee = abs(fill * size) * fee_rate
        pnl = (fill - entry) * size * pos - fee - entry_fee
        cash += (fill - entry) * size * pos - fee
        trades.append(Trade(pos, entry_time, entry, when, fill, size, pnl, fee + entry_fee, reason))
        pos = 0

    for i in range(1, n):
        o, h, l = op[i], hi[i], lo[i]
        want = sig[i - 1]  # décision prise à la clôture précédente
        if want == -1 and not cfg.allow_short:
            want = 0

        # 1) Sortie ou retournement sur signal, à l'ouverture.
        if pos != 0 and want != pos:
            close_position(o, ts[i], "signal")

        # 2) Entrée à l'ouverture.
        if pos == 0 and want != 0 and cash > 0:
            fill = o + half if want == 1 else o - half
            if cfg.sl_pct > 0 and cfg.risk_pct > 0:
                size = (cash * cfg.risk_pct / 100.0) / (fill * cfg.sl_pct / 100.0)
            else:
                size = cash * cfg.position_pct / 100.0 / fill
            if size > 0:
                pos, entry, entry_time = want, fill, ts[i]
                entry_fee = abs(fill * size) * fee_rate
                cash -= entry_fee
                stop = fill * (1 - want * cfg.sl_pct / 100.0) if cfg.sl_pct > 0 else 0.0
                target = fill * (1 + want * cfg.tp_pct / 100.0) if cfg.tp_pct > 0 else 0.0

        # 3) Stop loss / take profit pendant la bougie (stop prioritaire).
        if pos == 1:
            if stop and l <= stop:
                close_position(min(o, stop), ts[i], "stop")      # en cas de gap, exécution à l'ouverture
            elif target and h >= target:
                close_position(max(o, target), ts[i], "objectif")
        elif pos == -1:
            if stop and h >= stop:
                close_position(max(o, stop), ts[i], "stop")
            elif target and l <= target:
                close_position(min(o, target), ts[i], "objectif")

        equity[i] = cash + ((cl[i] - entry) * size * pos if pos else 0.0)
        if progress and i % tick == 0:
            progress(i / n)

    if pos != 0:
        close_position(cl[-1], ts[-1], "fin")
        equity[-1] = cash

    return {"metrics": compute_metrics(np.array(equity), trades, cfg.capital, tf),
            "trades": [asdict(t) for t in trades],
            "equity": _downsample(candles[:, 0], np.array(equity), 2000)}


def compute_metrics(equity: np.ndarray, trades: list[Trade], capital: float, tf: str) -> dict:
    """Statistiques de performance à partir de la courbe de capital et des trades."""
    pnls = np.array([t.pnl for t in trades], dtype=np.float64)
    wins, losses = pnls[pnls > 0], pnls[pnls <= 0]
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / np.where(peak > 0, peak, 1.0)
    rets = np.diff(equity) / np.where(equity[:-1] != 0, equity[:-1], 1.0)
    std = float(rets.std()) if len(rets) > 1 else 0.0
    sharpe = float(rets.mean() / std * np.sqrt(BARS_PER_YEAR.get(tf, 8760))) if std > 0 else 0.0
    gross_loss = float(-losses.sum())
    return {
        "capital_initial": float(capital),
        "capital_final": float(equity[-1]),
        "profit_net": float(equity[-1] - capital),
        "rendement_pct": float((equity[-1] / capital - 1) * 100) if capital else 0.0,
        "drawdown_max_pct": float(dd.max() * 100) if len(dd) else 0.0,
        "nb_trades": int(len(pnls)),
        "taux_reussite_pct": float(len(wins) / len(pnls) * 100) if len(pnls) else 0.0,
        "profit_factor": float(wins.sum() / gross_loss) if gross_loss > 0 else (float("inf") if len(wins) else 0.0),
        "sharpe": sharpe,
        "gain_moyen": float(wins.mean()) if len(wins) else 0.0,
        "perte_moyenne": float(losses.mean()) if len(losses) else 0.0,
        "esperance": float(pnls.mean()) if len(pnls) else 0.0,
        "frais_total": float(sum(t.fees for t in trades)),
    }


def _downsample(ts: np.ndarray, values: np.ndarray, limit: int) -> list[list[float]]:
    """Réduit la courbe à `limit` points au plus pour un affichage fluide."""
    if len(values) > limit:
        idx = np.unique(np.linspace(0, len(values) - 1, limit).astype(np.int64))
        ts, values = ts[idx], values[idx]
    return np.column_stack([ts, values]).tolist()
