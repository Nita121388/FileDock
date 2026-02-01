#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v cargo >/dev/null 2>&1; then
  echo "[fmt] rustfmt"
  cd "$ROOT"
  cargo fmt
else
  echo "[fmt] cargo not found; skipping rustfmt" >&2
fi

if command -v npm >/dev/null 2>&1; then
  echo "[fmt] prettier (desktop)"
  cd "$ROOT/apps/desktop"
  npm install
  npm run -s format || true
else
  echo "[fmt] npm not found; skipping prettier" >&2
fi

