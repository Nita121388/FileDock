#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"
echo "[release] dist: $DIST"

# Build rust binaries (if available).
if command -v cargo >/dev/null 2>&1; then
  echo "[release] building rust (release)"
  (cd "$ROOT" && cargo build --release -p filedock-server -p filedock -p filedock-tui)

  cp -f "$ROOT/target/release/filedock-server" "$DIST/" || true
  cp -f "$ROOT/target/release/filedock" "$DIST/" || true
  cp -f "$ROOT/target/release/filedock-tui" "$DIST/" || true
else
  echo "[release] cargo not found; skipping rust artifacts" >&2
fi

# Build desktop app (if available).
if command -v npm >/dev/null 2>&1; then
  echo "[release] building desktop (tauri build)"
  (cd "$ROOT/apps/desktop" && npm install && npm run tauri build)

  # Copy the entire bundle folder (platform-dependent outputs).
  if [ -d "$ROOT/apps/desktop/src-tauri/target/release/bundle" ]; then
    rm -rf "$DIST/desktop-bundle"
    cp -R "$ROOT/apps/desktop/src-tauri/target/release/bundle" "$DIST/desktop-bundle"
  fi
else
  echo "[release] npm not found; skipping desktop artifacts" >&2
fi

echo "[release] done"
ls -la "$DIST" || true

