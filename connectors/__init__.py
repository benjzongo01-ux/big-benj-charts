"""Registre des sources de données. Pour ajouter un fournisseur : un fichier + une ligne ici."""
from __future__ import annotations

from .base import TF_SECONDS, Connector, ConnectorError, clean, resample, tf_ms
from .binance import BinanceConnector
from .dukascopy import DukascopyConnector
from .mt5 import MT5Connector
from .twelvedata import TwelveDataConnector
from .yahoo import YahooConnector

REGISTRY: dict[str, Connector] = {
    c.name: c
    for c in (BinanceConnector(), DukascopyConnector(), YahooConnector(), MT5Connector(), TwelveDataConnector())
}


def get_connector(name: str) -> Connector:
    """Renvoie le connecteur demandé ou une erreur lisible."""
    if name not in REGISTRY:
        raise ConnectorError(f"Source de données inconnue : {name}")
    return REGISTRY[name]


__all__ = ["REGISTRY", "TF_SECONDS", "Connector", "ConnectorError", "clean", "get_connector", "resample", "tf_ms"]
