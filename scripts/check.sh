#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[check] repo: $ROOT"

if command -v cargo >/dev/null 2>&1; then
  echo "[check] rust: fmt"
  (cd "$ROOT" && cargo fmt)

  echo "[check] rust: clippy"
  (cd "$ROOT" && cargo clippy --workspace --all-targets --all-features -- -D warnings)

  echo "[check] rust: test"
  (cd "$ROOT" && cargo test --workspace)
else
  echo "[check] cargo not found; skipping rust fmt/clippy/test" >&2
fi

if command -v npm >/dev/null 2>&1; then
  echo "[check] desktop: build (tsc + vite)"
  (cd "$ROOT/apps/desktop" && npm ci && npm run build)
else
  echo "[check] npm not found; skipping desktop build" >&2
fi

echo "[check] smoke (open mode)"
FILEDOCK_SMOKE_PORT="${FILEDOCK_SMOKE_PORT:-18787}" "$ROOT/scripts/smoke.sh"

echo "[check] smoke (auth mode)"
FILEDOCK_SMOKE_PORT="${FILEDOCK_SMOKE_PORT_AUTH:-18788}" FILEDOCK_TOKEN="${FILEDOCK_TOKEN:-check-token}" "$ROOT/scripts/smoke.sh"

echo "[check] OK"

