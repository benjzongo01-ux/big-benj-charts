"""Comptes utilisateurs : mots de passe hachés (PBKDF2) et jetons de session signés (HMAC).

En usage personnel (AUTH_REQUIRED=false), aucune connexion : tout appartient à l'utilisateur local.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import time

from fastapi import Header, HTTPException, Query

from . import db
from .config import AUTH_REQUIRED, FIREBASE_ENABLED, LOCAL_USER_ID, SECRET_KEY

#: Identifiant d'utilisateur : nombre en local (SQLite), texte en ligne (Firebase).
UserId = int | str

TOKEN_DAYS = 30


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$")
    except ValueError:
        return False
    test = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return hmac.compare_digest(test.hex(), digest)


def make_token(user_id: int) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"u": user_id, "e": int(time.time()) + TOKEN_DAYS * 86400}).encode())
    sig = hmac.new(SECRET_KEY.encode(), body, hashlib.sha256).hexdigest()
    return f"{body.decode()}.{sig}"


def read_token(token: str) -> int | None:
    try:
        body, sig = token.rsplit(".", 1)
        good = hmac.new(SECRET_KEY.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(good, sig):
            return None
        data = json.loads(base64.urlsafe_b64decode(body.encode()))
        return int(data["u"]) if data["e"] > time.time() else None
    except Exception:
        return None


def register(email: str, password: str) -> int:
    email = email.strip().lower()
    if "@" not in email or len(password) < 8:
        raise HTTPException(400, "Adresse e-mail invalide ou mot de passe trop court (8 caractères minimum).")
    c = db.conn()
    try:
        cur = c.execute("INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)",
                        (email, hash_password(password), db.now()))
        c.commit()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Un compte existe déjà avec cette adresse.") from exc
    return int(cur.lastrowid or 0)


def login(email: str, password: str) -> int:
    row = db.conn().execute("SELECT user_id, password_hash FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
    if not row or not check_password(password, row["password_hash"]):
        raise HTTPException(401, "E-mail ou mot de passe incorrect.")
    return int(row["user_id"])


def identify(token: str | None) -> UserId | None:
    """Renvoie l'utilisateur correspondant à un jeton (Google en ligne, session locale sinon)."""
    if not token:
        return None
    if FIREBASE_ENABLED:
        from . import firebase_app

        return firebase_app.verify(token)
    return read_token(token)


def current_user(authorization: str | None = Header(default=None), token: str | None = Query(default=None)) -> UserId:
    """Dépendance FastAPI : identifie l'utilisateur de la requête."""
    raw = token or (authorization[7:] if authorization and authorization.lower().startswith("bearer ") else None)
    user_id = identify(raw)
    if user_id:
        return user_id
    if AUTH_REQUIRED:
        raise HTTPException(401, "Connexion requise.")
    return LOCAL_USER_ID
