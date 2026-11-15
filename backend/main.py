"""API de Big Benj Charts : REST + WebSocket temps réel.

Lancement : uvicorn backend.main:app --port 8000   (depuis la racine du projet)
"""
from __future__ import annotations

import asyncio
import math
import time
import uuid
from contextlib import asynccontextmanager, suppress

import numpy as np
from fastapi import Body, Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from connectors import REGISTRY, TF_SECONDS, ConnectorError, get_connector, tf_ms
from engine import BUILTIN, TEMPLATE, BacktestConfig, run_backtest, run_custom

from . import alerts, auth, db
from .config import (ALLOW_CUSTOM_CODE, AUTH_REQUIRED, FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_ENABLED, FIREBASE_WEB,
                     LOCAL_USER_ID, MAX_BARS, ROOT)
from .store import get_candles


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    # En ligne : le serveur surveille les alertes et notifie les téléphones.
    task = asyncio.create_task(alerts.worker()) if FIREBASE_ENABLED else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Big Benj Charts", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=4096)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Count"])

User = Depends(auth.current_user)


def _fail(exc: Exception) -> HTTPException:
    return HTTPException(502 if isinstance(exc, ConnectorError) else 400, str(exc))


# ------------------------------------------------------------------ comptes
@app.get("/api/auth/config")
async def auth_config() -> dict:
    firebase = None
    if FIREBASE_ENABLED:
        from . import firebase_app

        project = firebase_app.project_id()
        firebase = {"apiKey": FIREBASE_API_KEY, "projectId": project,
                    "authDomain": FIREBASE_AUTH_DOMAIN or f"{project}.firebaseapp.com", **FIREBASE_WEB}
    return {"auth_required": AUTH_REQUIRED, "custom_code": ALLOW_CUSTOM_CODE, "firebase": firebase}


def _local_accounts_only() -> None:
    if FIREBASE_ENABLED:
        raise HTTPException(400, "Sur cette version, la connexion se fait avec Google.")


@app.post("/api/auth/register")
def auth_register(email: str = Body(...), password: str = Body(...)) -> dict:
    _local_accounts_only()
    return {"token": auth.make_token(auth.register(email, password))}


@app.post("/api/auth/login")
def auth_login(email: str = Body(...), password: str = Body(...)) -> dict:
    _local_accounts_only()
    return {"token": auth.make_token(auth.login(email, password))}


@app.get("/api/auth/me")
def auth_me(user_id: auth.UserId = User) -> dict:
    if FIREBASE_ENABLED:
        from . import firebase_app

        return {"user_id": user_id, "email": firebase_app.email_of(str(user_id)), "local": False}
    row = db.conn().execute("SELECT email FROM users WHERE user_id=?", (user_id,)).fetchone()
    return {"user_id": user_id, "email": row["email"] if row else "", "local": user_id == LOCAL_USER_ID}


# ------------------------------------------------------------------ données
@app.get("/api/sources")
async def sources(_: int = User) -> list[dict]:
    out = []
    for c in REGISTRY.values():
        ok, why = c.available()
        out.append({"name": c.name, "label": c.label, "markets": c.markets, "available": ok, "message": why})
    return out


@app.get("/api/symbols")
async def symbols(source: str, _: int = User) -> list[dict]:
    try:
        return await get_connector(source).symbols()
    except ConnectorError as exc:
        raise _fail(exc) from exc


@app.get("/api/candles")
async def candles(source: str, symbol: str, tf: str, start: int | None = None, end: int | None = None,
                  limit: int = Query(default=3000, ge=1, le=2_000_000), user_id: auth.UserId = User) -> Response:
    """Bougies en binaire (float64, 6 colonnes) : bien plus léger et rapide à lire que du JSON."""
    try:
        step = tf_ms(tf)
        end_ms = end if end is not None else int(time.time() * 1000)
        limit = min(limit, MAX_BARS)
        start_ms = max(start if start is not None else end_ms - limit * step, end_ms - MAX_BARS * step)
        rows = await get_candles(user_id, source, symbol, tf, start_ms, end_ms)
        if start is None and len(rows) > limit:
            rows = rows[-limit:]
    except (ConnectorError, ValueError) as exc:
        raise _fail(exc) from exc
    return Response(np.ascontiguousarray(rows).tobytes(), media_type="application/octet-stream",
                    headers={"X-Count": str(len(rows))})


@app.websocket("/ws/stream")
async def stream(ws: WebSocket, source: str, symbol: str, tf: str, token: str | None = None) -> None:
    """Flux temps réel. Les mises à jour sont regroupées : un envoi toutes les 100 ms au maximum."""
    if AUTH_REQUIRED and not await asyncio.to_thread(auth.identify, token):
        await ws.close(code=4401)
        return
    await ws.accept()
    latest: list[float] | None = None
    dirty = asyncio.Event()

    async def reader() -> None:
        nonlocal latest
        async for bar in get_connector(source).stream(symbol, tf):
            latest = bar
            dirty.set()

    task = asyncio.create_task(reader())
    try:
        while True:
            await dirty.wait()
            dirty.clear()
            if latest is not None:
                await ws.send_json(latest)
            await asyncio.sleep(0.1)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except ConnectorError as exc:
        with suppress(Exception):
            await ws.send_json({"error": str(exc)})
    finally:
        task.cancel()
        with suppress(BaseException):
            await task


# ------------------------------------------------------------------ backtest
JOBS: dict[str, dict] = {}


class Cancelled(Exception):
    """Levée dans le moteur quand l'utilisateur annule."""


def _json_safe(value):
    """Remplace inf/NaN (non valides en JSON) par None."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


@app.get("/api/strategies")
def strategies(user_id: auth.UserId = User) -> dict:
    return {"builtin": [{"id": k, "label": v["label"], "params": v["params"]} for k, v in BUILTIN.items()],
            "template": TEMPLATE, "custom": db.list_strategies(user_id), "custom_code": ALLOW_CUSTOM_CODE}


@app.post("/api/strategies")
def strategy_save(name: str = Body(...), code: str = Body(...), user_id: auth.UserId = User) -> dict:
    if not name.strip():
        raise HTTPException(400, "Donne un nom à la stratégie.")
    return {"id": db.save_strategy(user_id, name.strip(), code)}


@app.delete("/api/strategies/{strategy_id}")
def strategy_delete(strategy_id: str, user_id: auth.UserId = User) -> dict:
    db.delete_strategy(user_id, strategy_id if FIREBASE_ENABLED else int(strategy_id))
    return {"ok": True}


@app.post("/api/backtest")
async def backtest_start(payload: dict = Body(...), user_id: auth.UserId = User) -> dict:
    """Lance un backtest en arrière-plan et renvoie un identifiant de suivi."""
    job_id = uuid.uuid4().hex
    job = {"user_id": user_id, "status": "running", "progress": 0.0, "result": None, "error": None, "cancel": False}
    JOBS[job_id] = job
    if len(JOBS) > 50:  # on ne garde que les plus récents
        for old in list(JOBS)[:-50]:
            JOBS.pop(old, None)

    async def work() -> None:
        try:
            source, symbol, tf = payload["source"], payload["symbol"], payload["tf"]
            end_ms = int(payload.get("end") or time.time() * 1000)
            start_ms = max(int(payload.get("start") or end_ms - 5000 * tf_ms(tf)), end_ms - MAX_BARS * tf_ms(tf))
            data = await get_candles(user_id, source, symbol, tf, start_ms, end_ms)
            if len(data) < 50:
                raise ValueError("Pas assez de données sur cette période (50 bougies minimum).")
            job["progress"] = 0.1
            fields = BacktestConfig.__dataclass_fields__
            cfg = BacktestConfig(**{k: (bool(v) if k == "allow_short" else float(v))
                                    for k, v in (payload.get("config") or {}).items() if k in fields})
            params = payload.get("params") or {}

            def compute() -> dict:
                if payload.get("code"):
                    if not ALLOW_CUSTOM_CODE:
                        raise ValueError("Les stratégies Python personnalisées sont désactivées sur ce serveur.")
                    signal = run_custom(payload["code"], data, params)
                else:
                    strat = BUILTIN.get(payload.get("strategy", ""))
                    if not strat:
                        raise ValueError("Stratégie inconnue.")
                    signal = strat["fn"](data, {**strat["params"], **params})

                def progress(p: float) -> None:
                    if job["cancel"]:
                        raise Cancelled()
                    job["progress"] = 0.1 + 0.9 * p

                return run_backtest(data, signal, cfg, tf, progress)

            started = time.perf_counter()
            result = await asyncio.to_thread(compute)  # calcul hors de la boucle : l'API reste réactive
            result["bars"] = len(data)
            result["duration_ms"] = round((time.perf_counter() - started) * 1000)
            job.update(status="done", progress=1.0, result=_json_safe(result))
        except Cancelled:
            job.update(status="cancelled")
        except Exception as exc:  # erreur lisible pour l'interface
            job.update(status="error", error=str(exc))

    job["task"] = asyncio.create_task(work())
    return {"job_id": job_id}


@app.get("/api/backtest/{job_id}")
async def backtest_status(job_id: str, user_id: auth.UserId = User) -> dict:
    job = JOBS.get(job_id)
    if not job or job["user_id"] != user_id:
        raise HTTPException(404, "Backtest introuvable.")
    return {k: job[k] for k in ("status", "progress", "result", "error")}


@app.delete("/api/backtest/{job_id}")
async def backtest_cancel(job_id: str, user_id: auth.UserId = User) -> dict:
    job = JOBS.get(job_id)
    if job and job["user_id"] == user_id:
        job["cancel"] = True
    return {"ok": True}


# ------------------------------------------------------------------ sauvegardes
@app.get("/api/drawings")
def drawings_get(source: str, symbol: str, user_id: auth.UserId = User) -> list:
    return db.get_drawings(user_id, source, symbol)


@app.put("/api/drawings")
def drawings_put(source: str, symbol: str, data: list = Body(...), user_id: auth.UserId = User) -> dict:
    db.set_drawings(user_id, source, symbol, data)
    return {"ok": True}


@app.get("/api/journal")
def journal_get(user_id: auth.UserId = User) -> list[dict]:
    return db.list_journal(user_id)


@app.post("/api/journal")
def journal_add(payload: dict = Body(...), user_id: auth.UserId = User) -> dict:
    return {"id": db.add_journal(user_id, str(payload.get("kind", "trade")), str(payload.get("source", "")),
                                 str(payload.get("symbol", "")), str(payload.get("tf", "")), payload.get("data") or {})}


@app.delete("/api/journal")
def journal_clear(user_id: auth.UserId = User) -> dict:
    db.clear_journal(user_id)
    return {"ok": True}


@app.get("/api/alerts")
def alerts_get(user_id: auth.UserId = User) -> list:
    return alerts.list_alerts(user_id)


@app.post("/api/alerts")
def alerts_upsert(alert: dict = Body(...), user_id: auth.UserId = User) -> list:
    """Crée ou modifie UNE alerte. Renvoie la liste à jour, identique sur tous les appareils du compte."""
    try:
        return alerts.upsert(user_id, alert)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/alerts/{alert_id}")
def alerts_delete(alert_id: str, user_id: auth.UserId = User) -> list:
    return alerts.remove(user_id, alert_id)


@app.post("/api/push/token")
def push_register(token: str = Body(..., embed=True), native: bool = Body(False, embed=True), user_id: auth.UserId = User) -> dict:
    """Enregistre cet appareil pour recevoir les alertes (navigateur, ou application Android avec sonnerie d'alarme)."""
    if not FIREBASE_ENABLED:
        return {"ok": False, "devices": 0}
    if not (20 < len(token) < 4096):
        raise HTTPException(400, "Jeton de notification invalide.")
    alerts.add_token(user_id, (alerts.NATIVE + token) if native else token)
    return {"ok": True, "devices": alerts.device_count(user_id)}


@app.delete("/api/push/token")
def push_unregister(token: str = Body(..., embed=True), user_id: auth.UserId = User) -> dict:
    alerts.remove_token(user_id, token)
    return {"ok": True}


@app.post("/api/push/test")
def push_test(user_id: auth.UserId = User) -> dict:
    """Envoie une notification d'essai à tous les appareils du compte."""
    sent = alerts.send_push(user_id, "Big Benj Charts", "Notification d'essai : les alertes sonneront sur cet appareil.", "test")
    return {"sent": sent, "devices": alerts.device_count(user_id)}


@app.get("/api/settings")
def settings_get(user_id: auth.UserId = User) -> dict:
    return db.get_settings(user_id)


@app.put("/api/settings")
def settings_put(data: dict = Body(...), user_id: auth.UserId = User) -> dict:
    db.set_settings(user_id, data)
    return {"ok": True}


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "timeframes": list(TF_SECONDS)}


# ------------------------------------------------------------------ interface compilée
DIST = ROOT / "frontend" / "dist"
MEDIA = {".js": "text/javascript", ".webmanifest": "application/manifest+json", ".html": "text/html",
         ".apk": "application/vnd.android.package-archive"}
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        file = DIST / path
        target = file if path and file.is_file() else DIST / "index.html"
        # La page, le service worker et le manifeste ne sont jamais gardés en cache : les mises à jour arrivent tout de suite.
        return FileResponse(target, media_type=MEDIA.get(target.suffix), headers={"Cache-Control": "no-cache"})
