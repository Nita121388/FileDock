#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[build] repo: $ROOT"

if command -v cargo >/dev/null 2>&1; then
  echo "[build] building rust (release)"
  cd "$ROOT"
  cargo build --release -p filedock-server -p filedock -p filedock-tui
else
  echo "[build] cargo not found; skipping rust build" >&2
fi

if command -v npm >/dev/null 2>&1; then
  echo "[build] building desktop UI (tauri build)"
  cd "$ROOT/apps/desktop"
  npm install
  npm run tauri build
else
  echo "[build] npm not found; skipping desktop build" >&2
fi

