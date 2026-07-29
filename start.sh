#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
PORT=8720

echo
echo "================================"
echo "  Marginalia - EPUB Reader"
echo "================================"
echo

if [[ ! -x "$VENV_PYTHON" ]]; then
    BOOTSTRAP_PYTHON=""
    for candidate in python3.11 python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 &&
           "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)'; then
            BOOTSTRAP_PYTHON="$candidate"
            break
        fi
    done
    if [[ -z "$BOOTSTRAP_PYTHON" ]]; then
        echo "[ERROR] Python 3.11 is required to create .venv."
        exit 1
    fi
    echo "[INFO] Creating project virtual environment..."
    "$BOOTSTRAP_PYTHON" -m venv "$VENV_DIR"
fi

"$VENV_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' || {
    echo "[ERROR] .venv must use Python 3.11. Remove it manually and run this script again."
    exit 1
}

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
fi

if ! "$VENV_PYTHON" -c 'import fastapi, ebooklib, bs4, multipart, pytest' 2>/dev/null; then
    echo "[INFO] Installing dependencies into .venv..."
    "$VENV_PYTHON" -m pip install -r "$PROJECT_ROOT/backend/requirements.txt"
fi

cd "$PROJECT_ROOT/backend"
echo "[INFO] Python: $VENV_PYTHON"
echo "[INFO] Starting server: http://127.0.0.1:$PORT"
exec "$VENV_PYTHON" -m uvicorn main:app --host 127.0.0.1 --port "$PORT"
