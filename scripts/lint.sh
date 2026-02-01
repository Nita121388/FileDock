#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v cargo >/dev/null 2>&1; then
  echo "[lint] clippy"
  cd "$ROOT"
  cargo clippy --all-targets --all-features -- -D warnings
else
  echo "[lint] cargo not found; skipping clippy" >&2
fi

if command -v npm >/dev/null 2>&1; then
  echo "[lint] eslint (desktop)"
  cd "$ROOT/apps/desktop"
  npm install
  npm run -s lint || true
else
  echo "[lint] npm not found; skipping eslint" >&2
fi

