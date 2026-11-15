"""Alertes de prix : une seule liste par compte, partagée par tous ses appareils, et surveillée par le serveur.

- Les appareils n'envoient plus leur liste entière mais une opération à la fois (créer / modifier / supprimer) :
  un téléphone qui n'est pas à jour ne peut donc pas écraser une alerte posée sur l'ordinateur.
- En ligne, une boucle vérifie les prix toutes les 10 secondes et envoie une notification (Firebase Cloud
  Messaging) à tous les appareils du compte quand une alerte est franchie, même application fermée.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time

import httpx

from connectors import get_connector
from connectors.binance import FUTURES

from . import db
from .config import FIREBASE_ENABLED

log = logging.getLogger("alertes")
MAX_ALERTS = 200
#: Préfixe des appareils inscrits par l'application Android (sonnerie native).
NATIVE = "android:"
FIELDS = {"id": str, "source": str, "symbol": str, "precision": int, "price": float, "condition": str,
          "message": str, "once": bool, "active": bool, "createdAt": float, "triggeredAt": float}
CONDITIONS = {"cross": "croise", "above": "passe au-dessus de", "below": "passe en dessous de"}

_lock = threading.RLock()
_alerts: dict[object, list[dict]] = {}      # utilisateur -> ses alertes
_tokens: dict[object, set[str]] = {}        # utilisateur -> ses appareils (jetons de notification)


# ---------------------------------------------------------------- liste d'un utilisateur
def _get(user_id) -> list[dict]:
    with _lock:
        if user_id not in _alerts:
            _alerts[user_id] = list(db.get_alerts(user_id))
        return _alerts[user_id]


def list_alerts(user_id) -> list[dict]:
    with _lock:
        return [dict(a) for a in _get(user_id)]


def _clean(raw: dict) -> dict:
    """Ne garde que les champs connus, au bon type."""
    out: dict = {}
    for key, kind in FIELDS.items():
        if key in raw and raw[key] is not None:
            out[key] = kind(raw[key])
    if not out.get("id") or not out.get("symbol") or not out.get("source") or out.get("price", 0) <= 0:
        raise ValueError("Alerte incomplète.")
    if out.get("condition") not in CONDITIONS:
        out["condition"] = "cross"
    out["message"] = out.get("message", "")[:120]
    out.setdefault("once", True)
    out.setdefault("active", True)
    out.setdefault("createdAt", time.time() * 1000)
    out.setdefault("precision", 2)
    return out


def upsert(user_id, raw: dict) -> list[dict]:
    alert = _clean(raw)
    with _lock:
        items = _get(user_id)
        for i, a in enumerate(items):
            if a["id"] == alert["id"]:
                items[i] = alert
                break
        else:
            if len(items) >= MAX_ALERTS:
                raise ValueError(f"{MAX_ALERTS} alertes au maximum.")
            items.append(alert)
        db.set_alerts(user_id, items)
        return [dict(a) for a in items]


def remove(user_id, alert_id: str) -> list[dict]:
    with _lock:
        items = [a for a in _get(user_id) if a["id"] != alert_id]
        _alerts[user_id] = items
        db.set_alerts(user_id, items)
        return [dict(a) for a in items]


# ---------------------------------------------------------------- appareils à notifier
def add_token(user_id, token: str) -> None:
    with _lock:
        known = _tokens.setdefault(user_id, set())
        if token in known:
            return
        known.add(token)
    db.add_token(user_id, token)


def remove_token(user_id, token: str) -> None:
    with _lock:
        _tokens.get(user_id, set()).discard(token)
    db.remove_token(user_id, token)


def device_count(user_id) -> int:
    with _lock:
        return len(_tokens.get(user_id, ()))


def send_push(user_id, title: str, body: str, tag: str) -> int:
    """Envoie une notification à tous les appareils du compte. Renvoie le nombre d'appareils atteints."""
    if not FIREBASE_ENABLED:
        return 0
    with _lock:
        tokens = list(_tokens.get(user_id, ()))
    if not tokens:
        return 0
    from firebase_admin import messaging

    from . import firebase_app

    data = {"title": title, "body": body, "tag": tag, "url": "/"}
    messages = []
    for token in tokens:
        if token.startswith(NATIVE):
            # Application Android : message prioritaire, la partie native fait sonner l'alarme.
            messages.append(messaging.Message(token=token[len(NATIVE):], data=data,
                                              android=messaging.AndroidConfig(priority="high", ttl=3600)))
        else:
            # Navigateur : c'est notre service worker qui affiche la notification (titre, vibration, clic).
            messages.append(messaging.Message(token=token, data=data,
                                              webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "3600"})))
    result = messaging.send_each(messages, app=firebase_app.app())
    sent = 0
    for token, response in zip(tokens, result.responses):
        if response.success:
            sent += 1
        elif isinstance(response.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
            remove_token(user_id, token)  # appareil désinstallé ou notifications retirées
    return sent


# ---------------------------------------------------------------- surveillance des prix (version en ligne)
def _fr(value: float, digits: int) -> str:
    return f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")


async def _prices(keys: set[tuple[str, str]], client: httpx.AsyncClient) -> dict[tuple[str, str], float]:
    """Dernier prix de chaque (source, symbole) qui porte une alerte active."""
    out: dict[tuple[str, str], float] = {}
    spot = sorted(s for src, s in keys if src == "binance" and s not in FUTURES)
    if spot:
        for host in ("https://api.binance.com", "https://data-api.binance.vision"):
            try:
                r = await client.get(f"{host}/api/v3/ticker/price", params={"symbols": json.dumps(spot, separators=(",", ":"))})
                r.raise_for_status()
                for row in r.json():
                    out[("binance", row["symbol"])] = float(row["price"])
                break
            except Exception:
                continue
    for src, symbol in keys:
        try:
            if src == "binance" and symbol in FUTURES:
                r = await client.get("https://fapi.binance.com/fapi/v1/ticker/price", params={"symbol": symbol})
                r.raise_for_status()
                out[(src, symbol)] = float(r.json()["price"])
            elif src == "fx":
                price, _ = await get_connector("fx").quote(symbol)  # type: ignore[attr-defined]
                out[(src, symbol)] = price
        except Exception:
            continue  # source indisponible un instant : on réessaie au prochain tour
    return out


def _evaluate(prices: dict[tuple[str, str], float], last: dict[tuple[str, str], float]) -> list[tuple[object, dict, float]]:
    """Compare le prix précédent et le prix actuel ; renvoie les alertes franchies et les met à jour."""
    hits: list[tuple[object, dict, float]] = []
    with _lock:
        for user_id, items in _alerts.items():
            changed = False
            for a in items:
                key = (a["source"], a["symbol"])
                if not a.get("active") or key not in prices or key not in last:
                    continue
                prev, price, level = last[key], prices[key], a["price"]
                if prev == price:
                    continue
                crossed = (prev < level <= price) if a["condition"] == "above" else (prev > level >= price) if a["condition"] == "below" \
                    else ((prev - level) * (price - level) <= 0 and prev != level)
                if crossed:
                    a["triggeredAt"] = time.time() * 1000
                    if a.get("once", True):
                        a["active"] = False
                    changed = True
                    hits.append((user_id, dict(a), price))
            if changed:
                db.set_alerts(user_id, items)
    return hits


def _preload() -> None:
    """Au démarrage : charge les alertes et les appareils de tous les comptes (une lecture par compte)."""
    for user_id, items, tokens in db.all_users():
        with _lock:
            _alerts[user_id] = items
            _tokens[user_id] = set(tokens)


async def worker() -> None:
    """Boucle de surveillance. Ne tourne qu'en ligne (Firebase configuré)."""
    try:
        await asyncio.to_thread(_preload)
    except Exception as exc:
        log.warning("Chargement des alertes impossible : %s", exc)
    last: dict[tuple[str, str], float] = {}
    keep_alive = os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/")
    tick = 0
    async with httpx.AsyncClient(timeout=8) as client:
        while True:
            try:
                with _lock:
                    keys = {(a["source"], a["symbol"]) for items in _alerts.values() for a in items if a.get("active")}
                if keys:
                    prices = await _prices(keys, client)
                    hits = await asyncio.to_thread(_evaluate, prices, last)
                    last.update(prices)
                    for user_id, a, price in hits:
                        body = f"{a['symbol']} {CONDITIONS[a['condition']]} {_fr(a['price'], a['precision'])} · prix {_fr(price, a['precision'])}"
                        if a.get("message"):
                            body += f" · {a['message']}"
                        await asyncio.to_thread(send_push, user_id, "Alerte de prix", body, a["id"])
                    # Tant qu'il reste des alertes à surveiller, le serveur gratuit ne doit pas s'endormir :
                    # il se rend visite à lui-même toutes les 10 minutes.
                    if keep_alive and tick % 60 == 0:
                        try:
                            await client.get(f"{keep_alive}/api/health")
                        except Exception:
                            pass
                else:
                    last.clear()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("Surveillance des alertes : %s", exc)
            tick += 1
            await asyncio.sleep(10)
