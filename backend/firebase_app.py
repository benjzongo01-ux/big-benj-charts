"""Liaison avec Firebase (version en ligne) : vérification des connexions Google et base Firestore.

Le module firebase-admin n'est chargé que si Firebase est configuré : en usage local, rien ne change.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .config import FIREBASE_SERVICE_ACCOUNT

_lock = threading.Lock()
_app = None
# jeton -> (identifiant, e-mail, expiration) : évite de revérifier la signature à chaque requête
_tokens: dict[str, tuple[str, str, float]] = {}
_emails: dict[str, str] = {}


def app():
    """Initialise Firebase une seule fois, à partir de la clé de compte de service."""
    global _app
    with _lock:
        if _app is None:
            import firebase_admin
            from firebase_admin import credentials

            raw = FIREBASE_SERVICE_ACCOUNT
            info = json.loads(Path(raw).read_text(encoding="utf-8")) if raw.endswith(".json") else json.loads(raw)
            _app = firebase_admin.initialize_app(credentials.Certificate(info))
        return _app


def project_id() -> str:
    return app().project_id or ""


def verify(token: str) -> str | None:
    """Vérifie un jeton de connexion Firebase et renvoie l'identifiant de l'utilisateur (ou None)."""
    now = time.time()
    hit = _tokens.get(token)
    if hit and hit[2] > now:
        return hit[0]
    from firebase_admin import auth

    try:
        claims = auth.verify_id_token(token, app=app(), clock_skew_seconds=30)
    except Exception:
        return None
    uid = str(claims["uid"])
    email = str(claims.get("email", ""))
    if len(_tokens) > 5000:
        for old in [t for t, v in _tokens.items() if v[2] <= now]:
            _tokens.pop(old, None)
    _tokens[token] = (uid, email, float(claims.get("exp", now + 300)))
    _emails[uid] = email
    return uid


def email_of(uid: str) -> str:
    return _emails.get(uid, "")


def firestore():
    """Client Firestore (base de données des utilisateurs)."""
    from firebase_admin import firestore as fs

    return fs.client(app())
