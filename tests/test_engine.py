"""Tests du moteur de backtest : profit, frais, drawdown, stop, absence de biais d'anticipation."""
from __future__ import annotations

import numpy as np
import pytest

from connectors.base import clean, resample
from engine import BUILTIN, BacktestConfig, run_backtest, run_custom
from engine import indicators as ind


def candles(opens: list[float], highs=None, lows=None, closes=None) -> np.ndarray:
    n = len(opens)
    o = np.array(opens, dtype=float)
    c = np.array(closes if closes is not None else opens, dtype=float)
    h = np.array(highs, dtype=float) if highs is not None else np.maximum(o, c)
    l = np.array(lows, dtype=float) if lows is not None else np.minimum(o, c)
    return np.column_stack([np.arange(n) * 3600_000.0, o, h, l, c, np.ones(n)])


def test_profit_simple_sans_frais():
    # Signal à la bougie 0 -> achat à l'ouverture de la bougie 1 (100) ; sortie à l'ouverture de la bougie 3 (120).
    data = candles([100, 100, 110, 120, 120])
    res = run_backtest(data, np.array([1, 1, 0, 0, 0]), BacktestConfig(capital=1000))
    assert len(res["trades"]) == 1
    t = res["trades"][0]
    assert t["entry_price"] == 100 and t["exit_price"] == 120
    assert t["pnl"] == pytest.approx(200)            # 10 unités x 20
    assert res["metrics"]["capital_final"] == pytest.approx(1200)
    assert res["metrics"]["taux_reussite_pct"] == 100


def test_vente_a_decouvert():
    data = candles([100, 100, 90, 80, 80])
    res = run_backtest(data, np.array([-1, -1, 0, 0, 0]), BacktestConfig(capital=1000))
    assert res["trades"][0]["pnl"] == pytest.approx(200)
    res = run_backtest(data, np.array([-1, -1, 0, 0, 0]), BacktestConfig(capital=1000, allow_short=False))
    assert res["trades"] == []


def test_frais_spread_slippage_commission():
    data = candles([100, 100, 110, 120, 120])
    cfg = BacktestConfig(capital=1000, spread=1.0, slippage=0.5, commission_pct=0.1)
    res = run_backtest(data, np.array([1, 1, 0, 0, 0]), cfg)
    t = res["trades"][0]
    assert t["entry_price"] == pytest.approx(101.0)   # 100 + spread/2 + slippage
    assert t["exit_price"] == pytest.approx(119.0)    # 120 - spread/2 - slippage
    size = 1000 / 101.0
    fees = size * 101.0 * 0.001 + size * 119.0 * 0.001
    assert t["fees"] == pytest.approx(fees)
    assert t["pnl"] == pytest.approx(size * 18.0 - fees)
    assert res["metrics"]["capital_final"] == pytest.approx(1000 + size * 18.0 - fees)


def test_stop_loss_et_taille_selon_risque():
    # Achat à 100, stop à 2 % = 98, touché pendant la bougie 2. Risque de 1 % du capital = 10.
    data = candles([100, 100, 100, 100], highs=[100, 101, 100, 100], lows=[100, 99.5, 97, 100])
    cfg = BacktestConfig(capital=1000, sl_pct=2.0, risk_pct=1.0)
    res = run_backtest(data, np.array([1, 1, 1, 1]), cfg)
    t = res["trades"][0]
    assert t["reason"] == "stop" and t["exit_price"] == pytest.approx(98)
    assert t["pnl"] == pytest.approx(-10)


def test_stop_prioritaire_sur_objectif_et_gap():
    data = candles([100, 100, 100], highs=[100, 106, 100], lows=[100, 97, 100])
    res = run_backtest(data, np.array([1, 1, 1]), BacktestConfig(capital=1000, sl_pct=2, tp_pct=5))
    assert res["trades"][0]["reason"] == "stop"
    # Gap : l'ouverture est déjà sous le stop -> exécution au prix d'ouverture, pas au stop.
    data = candles([100, 100, 90, 90], highs=[100, 100, 91, 90], lows=[100, 100, 89, 90])
    res = run_backtest(data, np.array([1, 1, 1, 1]), BacktestConfig(capital=1000, sl_pct=2))
    assert res["trades"][0]["exit_price"] == pytest.approx(90)


def test_drawdown_max():
    data = candles([100, 100, 120, 60, 90, 90], closes=[100, 120, 60, 90, 90, 90])
    res = run_backtest(data, np.array([1, 1, 1, 1, 0, 0]), BacktestConfig(capital=1000))
    # Capital : 1000 -> 1200 -> 600 : drawdown de 50 %.
    assert res["metrics"]["drawdown_max_pct"] == pytest.approx(50)


def test_aucun_biais_anticipation():
    rng = np.random.default_rng(7)
    close = 100 + np.cumsum(rng.normal(0, 1, 600))
    data = np.column_stack([np.arange(600) * 3600_000.0, close, close + 1, close - 1, close, np.ones(600)])
    for name, strat in BUILTIN.items():
        full = strat["fn"](data, strat["params"])
        cut = strat["fn"](data[:400], strat["params"])
        assert np.array_equal(full[:400], cut), f"{name} utilise des données futures"
    # Modifier le futur ne change pas les trades déjà clôturés.
    sig = BUILTIN["sma_cross"]["fn"](data, {"rapide": 5, "lente": 20})
    a = run_backtest(data[:400], sig[:400], BacktestConfig())
    other = data.copy()
    other[400:, 1:5] *= 3
    b = run_backtest(other, BUILTIN["sma_cross"]["fn"](other, {"rapide": 5, "lente": 20}), BacktestConfig())
    closed = [t for t in a["trades"] if t["reason"] != "fin"]
    assert closed and closed == b["trades"][: len(closed)]


def test_indicateurs():
    x = np.arange(1, 11, dtype=float)
    assert ind.sma(x, 3)[-1] == pytest.approx(9)
    assert np.isnan(ind.sma(x, 3)[1])
    assert ind.rsi(x, 5)[-1] == pytest.approx(100)
    assert ind.rolling_max(x, 4)[-1] == 10 and ind.rolling_min(x, 4)[-1] == 7


def test_strategie_personnalisee():
    data = candles(list(range(100, 160)))
    code = "def strategy(open, high, low, close, volume, params):\n    return np.where(close > ind.sma(close, 5), 1, 0)\n"
    sig = run_custom(code, data, {})
    assert sig[-1] == 1 and sig[0] == 0
    with pytest.raises(ValueError):
        run_custom("x = 1", data, {})


def test_resample_et_nettoyage():
    rows = candles([1, 2, 3, 4, 5, 6, 7, 8])
    rows[:, 0] = np.arange(8) * 60_000.0
    out = resample(rows, "5m")
    assert len(out) == 2 and out[0, 1] == 1 and out[0, 4] == 5 and out[0, 2] == 5 and out[0, 5] == 5
    dup = np.vstack([rows, rows[-1:]])
    assert len(clean(dup)) == 8
