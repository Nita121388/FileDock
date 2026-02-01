#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[bootstrap] missing: $1" >&2
    return 1
  fi
  return 0
}

echo "[bootstrap] repo: $ROOT"

missing=0

need cargo || missing=1
need rustup || missing=1
need node || missing=1
need npm || missing=1

if [ "$missing" -ne 0 ]; then
  cat >&2 <<'EOF'
[bootstrap] One or more prerequisites are missing.
[bootstrap] See docs/build.md for the full prerequisites list.
EOF
  exit 2
fi

echo "[bootstrap] versions:"
echo "  rustc:  $(rustc -V 2>/dev/null || true)"
echo "  cargo:  $(cargo -V 2>/dev/null || true)"
echo "  node:   $(node -v 2>/dev/null || true)"
echo "  npm:    $(npm -v 2>/dev/null || true)"

echo "[bootstrap] rust components:"
if rustup component list --installed | rg -q '^rustfmt'; then
  echo "  rustfmt: installed"
else
  echo "  rustfmt: missing (run: rustup component add rustfmt)" >&2
  missing=1
fi
if rustup component list --installed | rg -q '^clippy'; then
  echo "  clippy:  installed"
else
  echo "  clippy:  missing (run: rustup component add clippy)" >&2
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  exit 2
fi

echo "[bootstrap] OK"

