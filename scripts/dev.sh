#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure cargo is available in non-login shells (e.g. IDE tasks).
if [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Start a dev server in the background (if cargo is available).
if command -v cargo >/dev/null 2>&1; then
  export FILEDOCK_LISTEN="${FILEDOCK_LISTEN:-127.0.0.1:8787}"
  export FILEDOCK_STORAGE_DIR="${FILEDOCK_STORAGE_DIR:-$ROOT/filedock-data}"
  mkdir -p "$FILEDOCK_STORAGE_DIR"
  echo "[dev] starting server on $FILEDOCK_LISTEN (data: $FILEDOCK_STORAGE_DIR)"
  (cd "$ROOT" && cargo run -p filedock-server) &
  SERVER_PID=$!
  trap 'echo "[dev] stopping server"; kill "$SERVER_PID" 2>/dev/null || true' EXIT
else
  echo "[dev] cargo not found; skipping server start"
fi

# Start desktop UI (tauri) dev.
if command -v npm >/dev/null 2>&1; then
  echo "[dev] starting desktop UI (tauri dev)"
  cd "$ROOT/apps/desktop"
  npm install
  npm run tauri dev
else
  echo "[dev] npm not found; cannot start desktop UI" >&2
  exit 1
fi
