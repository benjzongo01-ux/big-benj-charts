@echo off
rem Lance Big Benj Charts : serveur + interface, puis ouvre le navigateur.
cd /d "%~dp0"
if not exist .venv (
  echo Installation de Python...
  python -m venv .venv
  .venv\Scripts\python -m pip install -q -r requirements.txt
)
if not exist frontend\dist (
  echo Construction de l'interface...
  pushd frontend
  call npm install --no-audit --no-fund
  call npm run build
  popd
)
start "" http://127.0.0.1:8000
.venv\Scripts\python -m uvicorn backend.main:app --port 8000
