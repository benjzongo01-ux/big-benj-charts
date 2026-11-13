"""Configuration : lit le fichier .env (aucune clé ni mot de passe dans le code)."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)


def _load_env() -> None:
    """Charge les lignes CLE=valeur du fichier .env sans écraser l'environnement existant."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _secret() -> str:
    """Clé de signature des sessions : celle du .env, sinon une clé générée une fois et gardée en local."""
    if os.getenv("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = DATA_DIR / ".secret"
    if not path.exists():
        path.write_text(secrets.token_hex(32), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


_load_env()

#: False = usage personnel sans connexion (utilisateur local n°1). True = comptes obligatoires.
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "false").lower() in ("1", "true", "yes", "oui")
#: Autorise l'exécution de stratégies Python personnalisées. À laisser sur false en version publique.
ALLOW_CUSTOM_CODE = os.getenv("ALLOW_CUSTOM_CODE", "true").lower() in ("1", "true", "yes", "oui")
SECRET_KEY = _secret()
LOCAL_USER_ID = 1
