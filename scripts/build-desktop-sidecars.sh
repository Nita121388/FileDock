#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"

if ! command -v rustc >/dev/null 2>&1; then
  echo "[desktop-sidecars] rustc not found; install Rust toolchain first" >&2
  exit 1
fi

HOST_TRIPLE="$(rustc -vV | rg '^host:' | awk '{print $2}')"
if [[ -z "${HOST_TRIPLE}" ]]; then
  echo "[desktop-sidecars] failed to determine Rust host triple" >&2
  exit 1
fi

EXT=""
if [[ "${HOST_TRIPLE}" == *"windows"* ]]; then
  EXT=".exe"
fi

mkdir -p "$OUT_DIR"

echo "[desktop-sidecars] host=${HOST_TRIPLE}"

echo "[desktop-sidecars] building filedock (rust)"
(cd "$ROOT" && cargo build -p filedock --release)

SRC_FD="$ROOT/target/release/filedock${EXT}"
DST_FD="$OUT_DIR/filedock-${HOST_TRIPLE}${EXT}"
if [[ ! -f "$SRC_FD" ]]; then
  echo "[desktop-sidecars] expected binary missing: $SRC_FD" >&2
  exit 1
fi
cp -f "$SRC_FD" "$DST_FD"
chmod +x "$DST_FD" 2>/dev/null || true
echo "[desktop-sidecars] wrote $DST_FD"

if command -v go >/dev/null 2>&1; then
  echo "[desktop-sidecars] building filedock-sftp (go)"
  tmp="$OUT_DIR/.tmp_filedock-sftp${EXT}"
  (cd "$ROOT/plugins/sftp" && go build -o "$tmp")
  DST_SFTP="$OUT_DIR/filedock-sftp-${HOST_TRIPLE}${EXT}"
  mv -f "$tmp" "$DST_SFTP"
  chmod +x "$DST_SFTP" 2>/dev/null || true
  echo "[desktop-sidecars] wrote $DST_SFTP"
else
  echo "[desktop-sidecars] go not found; skipping filedock-sftp sidecar" >&2
fi

echo "[desktop-sidecars] done"
