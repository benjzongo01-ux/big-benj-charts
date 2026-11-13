"""Moteur de backtest : exécution, statistiques, stratégies."""
from .backtest import BacktestConfig, Trade, compute_metrics, run_backtest
from .strategies import BUILTIN, TEMPLATE, run_custom

__all__ = ["BUILTIN", "TEMPLATE", "BacktestConfig", "Trade", "compute_metrics", "run_backtest", "run_custom"]
