# Big Benj Charts

Plateforme personnelle de backtesting, de replay et d'analyse en temps réel, 100 % gratuite,
prête pour le multi-utilisateurs.

## Lancer

Double-clique sur `lancer.bat` (Windows). La première fois, il installe tout puis ouvre
http://127.0.0.1:8000 dans le navigateur.

À la main :

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
.venv\Scripts\python -m uvicorn backend.main:app --port 8000
```

Pour développer l'interface avec rechargement automatique : `cd frontend && npm run dev`
(port 5173, le serveur Python doit tourner sur le port 8000).

Tests du moteur : `.venv\Scripts\python -m pytest tests`

## Mettre en ligne

Voir [DEPLOIEMENT.md](DEPLOIEMENT.md) : GitHub + Firebase (connexion Google) + Render, le tout gratuit.

## Dossiers

| Dossier | Rôle |
| --- | --- |
| `connectors/` | Une source de données par fichier, toutes avec la même interface `get_history` / `stream` |
| `engine/` | Moteur de backtest, indicateurs, stratégies |
| `backend/` | API FastAPI (REST + WebSocket), comptes, stockage |
| `frontend/` | Interface React + TypeScript, graphiques KLineChart |
| `tests/` | Tests automatiques du moteur |
| `data/` | Bougies en cache et base SQLite (créé au premier lancement, jamais versionné) |

## Sources de données

| Source | Marchés | Temps réel | Remarque |
| --- | --- | --- | --- |
| Binance | Crypto | Oui (WebSocket) | Sans clé |
| Dukascopy | Forex, or, indices, pétrole | Non (différé) | Lent au premier téléchargement, puis en cache |
| Yahoo Finance | Actions, indices | Différé | 1 minute limité à 7 jours, 5-30 minutes à 60 jours |
| MetaTrader 5 | Forex, indices, matières premières | Oui | `pip install MetaTrader5` + terminal MT5 ouvert |
| Twelve Data | Actions | Oui (quota) | Clé gratuite dans `.env` |

## Réglages

Copie `.env.example` en `.env`. Aucune clé n'est nécessaire pour Binance, Dukascopy et Yahoo.
Pour une version publique : `AUTH_REQUIRED=true` et `ALLOW_CUSTOM_CODE=false`.

## Raccourcis

Alt+T ligne de tendance · Alt+F Fibonacci · Alt+H ligne horizontale · Alt+V ligne verticale ·
Échap annuler · Suppr effacer le dessin sélectionné · Espace lecture/pause du replay ·
Flèche droite bougie suivante.
