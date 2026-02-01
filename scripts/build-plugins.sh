#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT/plugins/bin"

if command -v go >/dev/null 2>&1; then
  echo "[build-plugins] building filedock-sftp (go)"
  (cd "$ROOT" && go build -o plugins/bin/filedock-sftp ./plugins/sftp)
else
  echo "[build-plugins] go not found; skipping filedock-sftp" >&2
fi

echo "[build-plugins] done"

