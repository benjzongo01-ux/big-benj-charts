"""Tests des alertes : opérations par appareil et déclenchement par le serveur."""
from __future__ import annotations

import pytest

from backend import alerts


@pytest.fixture(autouse=True)
def memoire(monkeypatch):
    """Remplace la base par un dictionnaire en mémoire."""
    store: dict = {}
    monkeypatch.setattr(alerts.db, "get_alerts", lambda uid: list(store.get(uid, [])))
    monkeypatch.setattr(alerts.db, "set_alerts", lambda uid, items: store.__setitem__(uid, [dict(a) for a in items]))
    alerts._alerts.clear()
    alerts._tokens.clear()
    yield store
    alerts._alerts.clear()


def alerte(ident: str, prix: float, condition: str = "cross", **extra) -> dict:
    return {"id": ident, "source": "binance", "symbol": "BTCUSDT", "precision": 2, "price": prix, "condition": condition, **extra}


def test_deux_appareils_ne_s_ecrasent_pas(memoire):
    # L'ordinateur crée une alerte, le téléphone (pas à jour) en crée une autre : les deux restent.
    alerts.upsert("u", alerte("pc", 100))
    apres = alerts.upsert("u", alerte("tel", 200))
    assert [a["id"] for a in apres] == ["pc", "tel"]
    assert [a["id"] for a in memoire["u"]] == ["pc", "tel"]
    # Modifier une alerte ne touche pas l'autre ; supprimer non plus.
    alerts.upsert("u", alerte("pc", 150))
    assert [a["price"] for a in alerts.list_alerts("u")] == [150, 200]
    assert [a["id"] for a in alerts.remove("u", "pc")] == ["tel"]


def test_alerte_invalide_refusee():
    with pytest.raises(ValueError):
        alerts.upsert("u", {"id": "x"})
    with pytest.raises(ValueError):
        alerts.upsert("u", alerte("y", -5))


def test_declenchement_croise_et_unique(memoire):
    alerts.upsert("u", alerte("a", 100, "cross"))
    cle = ("binance", "BTCUSDT")
    assert alerts._evaluate({cle: 99.0}, {}) == []                    # premier prix connu : rien à comparer
    assert alerts._evaluate({cle: 99.5}, {cle: 99.0}) == []           # le prix n'a pas franchi 100
    hits = alerts._evaluate({cle: 100.4}, {cle: 99.5})
    assert len(hits) == 1 and hits[0][1]["id"] == "a" and hits[0][2] == 100.4
    assert memoire["u"][0]["active"] is False                          # « une seule fois » : désactivée et enregistrée
    assert alerts._evaluate({cle: 99.0}, {cle: 100.4}) == []          # ne sonne pas une seconde fois


def test_conditions_au_dessus_en_dessous_et_repetee():
    alerts.upsert("u", alerte("haut", 100, "above", once=False))
    alerts.upsert("u", alerte("bas", 90, "below"))
    cle = ("binance", "BTCUSDT")
    assert [h[1]["id"] for h in alerts._evaluate({cle: 101.0}, {cle: 99.0})] == ["haut"]
    assert alerts._evaluate({cle: 95.0}, {cle: 101.0}) == []           # redescendre sous 100 ne déclenche pas « au-dessus »
    assert [h[1]["id"] for h in alerts._evaluate({cle: 89.0}, {cle: 95.0})] == ["bas"]
    assert [h[1]["id"] for h in alerts._evaluate({cle: 102.0}, {cle: 89.0})] == ["haut"]  # « à chaque fois » : sonne encore


def test_alerte_en_pause_ou_autre_symbole_ignoree():
    alerts.upsert("u", alerte("pause", 100, active=False))
    alerts.upsert("u", {**alerte("eth", 100), "symbol": "ETHUSDT"})
    cle = ("binance", "BTCUSDT")
    assert alerts._evaluate({cle: 101.0}, {cle: 99.0}) == []
