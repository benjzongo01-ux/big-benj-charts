"""Stockage en ligne dans Firestore : mêmes fonctions que db.py (SQLite), utilisées quand Firebase est configuré.

Organisation : users/{uid} (réglages) puis sous-collections drawings, strategies, journal.
Chaque utilisateur n'accède qu'à sa propre branche : l'identifiant vient du jeton Google vérifié.
"""
from __future__ import annotations

import json
import time

from .firebase_app import firestore


def _user(user_id):
    return firestore().collection("users").document(str(user_id))


def _key(source: str, symbol: str) -> str:
    return f"{source}__{symbol}".replace("/", "_")


def init() -> None:
    firestore()  # vérifie la clé dès le démarrage : une erreur de configuration se voit tout de suite


def now() -> int:
    return int(time.time())


# --- Dessins -------------------------------------------------------------
def get_drawings(user_id, source: str, symbol: str) -> list:
    doc = _user(user_id).collection("drawings").document(_key(source, symbol)).get()
    return json.loads(doc.get("data")) if doc.exists else []


def set_drawings(user_id, source: str, symbol: str, data: list) -> None:
    _user(user_id).collection("drawings").document(_key(source, symbol)).set(
        {"source": source, "symbol": symbol, "data": json.dumps(data), "updated_at": now()})


# --- Stratégies ----------------------------------------------------------
def list_strategies(user_id) -> list[dict]:
    docs = _user(user_id).collection("strategies").stream()
    rows = [{"id": d.id, **(d.to_dict() or {})} for d in docs]
    return sorted(rows, key=lambda r: str(r.get("name", "")).lower())


def save_strategy(user_id, name: str, code: str) -> str:
    col = _user(user_id).collection("strategies")
    existing = list(col.where("name", "==", name).limit(1).stream())
    ref = existing[0].reference if existing else col.document()
    ref.set({"name": name, "code": code, "updated_at": now()})
    return ref.id


def delete_strategy(user_id, strategy_id) -> None:
    _user(user_id).collection("strategies").document(str(strategy_id)).delete()


# --- Journal -------------------------------------------------------------
def add_journal(user_id, kind: str, source: str, symbol: str, tf: str, data: dict) -> str:
    ref = _user(user_id).collection("journal").document()
    ref.set({"kind": kind, "source": source, "symbol": symbol, "tf": tf, "data": json.dumps(data), "created_at": now()})
    return ref.id


def list_journal(user_id, limit: int = 200) -> list[dict]:
    from google.cloud.firestore import Query

    docs = _user(user_id).collection("journal").order_by("created_at", direction=Query.DESCENDING).limit(limit).stream()
    out = []
    for d in docs:
        row = d.to_dict() or {}
        out.append({"id": d.id, **row, "data": json.loads(row.get("data", "{}"))})
    return out


def clear_journal(user_id) -> None:
    col = _user(user_id).collection("journal")
    while True:
        docs = list(col.limit(300).stream())
        if not docs:
            return
        batch = firestore().batch()
        for d in docs:
            batch.delete(d.reference)
        batch.commit()


# --- Réglages ------------------------------------------------------------
def get_settings(user_id) -> dict:
    doc = _user(user_id).get()
    raw = doc.get("settings") if doc.exists and "settings" in (doc.to_dict() or {}) else None
    return json.loads(raw) if raw else {}


def set_settings(user_id, data: dict) -> None:
    _user(user_id).set({"settings": json.dumps(data), "updated_at": now()}, merge=True)


# --- Alertes de prix -----------------------------------------------------
def get_alerts(user_id) -> list:
    doc = _user(user_id).get()
    raw = (doc.to_dict() or {}).get("alerts") if doc.exists else None
    return json.loads(raw) if raw else []


def set_alerts(user_id, data: list) -> None:
    _user(user_id).set({"alerts": json.dumps(data), "updated_at": now()}, merge=True)


# --- Appareils à notifier (jetons Firebase Cloud Messaging) ----------------
def add_token(user_id, token: str) -> None:
    from google.cloud.firestore import ArrayUnion

    _user(user_id).set({"tokens": ArrayUnion([token]), "updated_at": now()}, merge=True)


def remove_token(user_id, token: str) -> None:
    from google.cloud.firestore import ArrayRemove

    _user(user_id).set({"tokens": ArrayRemove([token])}, merge=True)


def all_users() -> list[tuple[str, list, list]]:
    """Alertes et appareils de tous les comptes : lu une fois au démarrage du serveur."""
    out = []
    for doc in firestore().collection("users").stream():
        data = doc.to_dict() or {}
        out.append((doc.id, json.loads(data.get("alerts") or "[]"), list(data.get("tokens") or [])))
    return out
