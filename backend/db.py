"""Base SQLite : comptes, dessins, stratégies, journal de trades, réglages.

Toutes les tables portent un user_id : la plateforme est multi-utilisateurs dès le départ.
(Les bougies, elles, sont dans des fichiers binaires par utilisateur : voir store.py.)
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time

from .config import DATA_DIR, FIREBASE_ENABLED, LOCAL_USER_ID

DB_PATH = DATA_DIR / "app.db"
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drawings (
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source, symbol)
);
CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_user ON journal (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


def conn() -> sqlite3.Connection:
    """Une connexion par fil d'exécution (SQLite en mode WAL : lectures et écritures simultanées)."""
    if not hasattr(_local, "conn"):
        c = sqlite3.connect(DB_PATH, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.conn = c
    return _local.conn


def init() -> None:
    c = conn()
    c.executescript(SCHEMA)
    # Utilisateur local pour l'usage personnel sans connexion.
    c.execute("INSERT OR IGNORE INTO users (user_id, email, password_hash, created_at) VALUES (?, 'local', '', ?)",
              (LOCAL_USER_ID, int(time.time())))
    c.commit()


def now() -> int:
    return int(time.time())


# --- Dessins -------------------------------------------------------------
def get_drawings(user_id: int, source: str, symbol: str) -> list:
    row = conn().execute("SELECT data FROM drawings WHERE user_id=? AND source=? AND symbol=?",
                         (user_id, source, symbol)).fetchone()
    return json.loads(row["data"]) if row else []


def set_drawings(user_id: int, source: str, symbol: str, data: list) -> None:
    c = conn()
    c.execute("INSERT INTO drawings (user_id, source, symbol, data, updated_at) VALUES (?,?,?,?,?) "
              "ON CONFLICT (user_id, source, symbol) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
              (user_id, source, symbol, json.dumps(data), now()))
    c.commit()


# --- Stratégies ----------------------------------------------------------
def list_strategies(user_id: int) -> list[dict]:
    rows = conn().execute("SELECT id, name, code, updated_at FROM strategies WHERE user_id=? ORDER BY name", (user_id,))
    return [dict(r) for r in rows]


def save_strategy(user_id: int, name: str, code: str) -> int:
    c = conn()
    c.execute("INSERT INTO strategies (user_id, name, code, updated_at) VALUES (?,?,?,?) "
              "ON CONFLICT (user_id, name) DO UPDATE SET code=excluded.code, updated_at=excluded.updated_at",
              (user_id, name, code, now()))
    c.commit()
    return int(c.execute("SELECT id FROM strategies WHERE user_id=? AND name=?", (user_id, name)).fetchone()["id"])


def delete_strategy(user_id: int, strategy_id: int) -> None:
    c = conn()
    c.execute("DELETE FROM strategies WHERE user_id=? AND id=?", (user_id, strategy_id))
    c.commit()


# --- Journal (trades du replay, résultats de backtests) -------------------
def add_journal(user_id: int, kind: str, source: str, symbol: str, tf: str, data: dict) -> int:
    c = conn()
    cur = c.execute("INSERT INTO journal (user_id, kind, source, symbol, tf, data, created_at) VALUES (?,?,?,?,?,?,?)",
                    (user_id, kind, source, symbol, tf, json.dumps(data), now()))
    c.commit()
    return int(cur.lastrowid or 0)


def list_journal(user_id: int, limit: int = 200) -> list[dict]:
    rows = conn().execute("SELECT id, kind, source, symbol, tf, data, created_at FROM journal WHERE user_id=? "
                          "ORDER BY created_at DESC, id DESC LIMIT ?", (user_id, limit))
    return [{**dict(r), "data": json.loads(r["data"])} for r in rows]


def clear_journal(user_id: int) -> None:
    c = conn()
    c.execute("DELETE FROM journal WHERE user_id=?", (user_id,))
    c.commit()


# --- Réglages (watchlist, thème, disposition) -----------------------------
def get_settings(user_id: int) -> dict:
    row = conn().execute("SELECT data FROM settings WHERE user_id=?", (user_id,)).fetchone()
    return json.loads(row["data"]) if row else {}


def set_settings(user_id: int, data: dict) -> None:
    c = conn()
    c.execute("INSERT INTO settings (user_id, data, updated_at) VALUES (?,?,?) "
              "ON CONFLICT (user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
              (user_id, json.dumps(data), now()))
    c.commit()


# --- Alertes de prix (la liste complète de l'utilisateur) ------------------
def get_alerts(user_id: int) -> list:
    row = conn().execute("SELECT data FROM alerts WHERE user_id=?", (user_id,)).fetchone()
    return json.loads(row["data"]) if row else []


def set_alerts(user_id: int, data: list) -> None:
    c = conn()
    c.execute("INSERT INTO alerts (user_id, data, updated_at) VALUES (?,?,?) "
              "ON CONFLICT (user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
              (user_id, json.dumps(data), now()))
    c.commit()


# --- Appareils à notifier : uniquement en ligne (Firestore). En local, rien à faire. ---
def add_token(user_id: int, token: str) -> None:
    return None


def remove_token(user_id: int, token: str) -> None:
    return None


def all_users() -> list:
    return []


# En ligne, les mêmes fonctions écrivent dans Firestore : le disque du serveur gratuit est effacé à chaque redémarrage.
if FIREBASE_ENABLED:
    from .db_firestore import (  # noqa: E402,F401,F811
        add_journal, add_token, all_users, clear_journal, delete_strategy, get_alerts, get_drawings, get_settings, init,
        list_journal, list_strategies, remove_token, save_strategy, set_alerts, set_drawings, set_settings,
    )
