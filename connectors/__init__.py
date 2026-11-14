"""Registre des sources de données. Pour ajouter un fournisseur : un fichier + une ligne ici."""
from __future__ import annotations

from .base import TF_SECONDS, Connector, ConnectorError, clean, resample, tf_ms
from .binance import BinanceConnector
from .dukascopy import DukascopyConnector
from .fx import FxConnector
from .mt5 import MT5Connector

REGISTRY: dict[str, Connector] = {
    c.name: c
    # Crypto et matières premières (Binance), forex (Yahoo + Swissquote), courtier (MT5), puis Dukascopy en secours.
    for c in (BinanceConnector(), FxConnector(), MT5Connector(), DukascopyConnector())
}


def get_connector(name: str) -> Connector:
    """Renvoie le connecteur demandé ou une erreur lisible."""
    if name not in REGISTRY:
        raise ConnectorError(f"Source de données inconnue : {name}")
    return REGISTRY[name]


__all__ = ["REGISTRY", "TF_SECONDS", "Connector", "ConnectorError", "clean", "get_connector", "resample", "tf_ms"]
