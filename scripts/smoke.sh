#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[smoke] missing dependency: $1" >&2
    exit 1
  fi
}

need curl
need sha256sum
need mktemp

PORT="${FILEDOCK_SMOKE_PORT:-8787}"
ADDR="127.0.0.1:${PORT}"
BASE="http://$ADDR"
TOKEN="${FILEDOCK_TOKEN:-}"

TMP="$(mktemp -d)"
DATA="$TMP/data"
SRC="$TMP/src"
OUT="$TMP/out"
mkdir -p "$DATA" "$SRC" "$OUT"

echo "[smoke] tmp: $TMP"
echo "[smoke] server: $BASE"

run_server() {
  if [ -x "$ROOT/target/release/filedock-server" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/release/filedock-server" --listen "$ADDR" --storage-dir "$DATA"
  elif [ -x "$ROOT/target/debug/filedock-server" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/debug/filedock-server" --listen "$ADDR" --storage-dir "$DATA"
  else
    need cargo
    (cd "$ROOT" && FILEDOCK_LISTEN="$ADDR" FILEDOCK_STORAGE_DIR="$DATA" FILEDOCK_TOKEN="$TOKEN" cargo run -p filedock-server)
  fi
}

run_cli() {
  if [ -x "$ROOT/target/release/filedock" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/release/filedock" "$@"
  elif [ -x "$ROOT/target/debug/filedock" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/debug/filedock" "$@"
  else
    need cargo
    (cd "$ROOT" && FILEDOCK_TOKEN="$TOKEN" cargo run -p filedock -- "$@")
  fi
}

cleanup() {
  echo "[smoke] cleanup"
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "[smoke] starting server..."
run_server >/dev/null 2>&1 &
SERVER_PID=$!

echo "[smoke] waiting for /health..."
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

curl -fsS "$BASE/health" | sed -n '1,5p'

echo "[smoke] preparing sample folder..."
mkdir -p "$SRC/a/b"
echo "hello" > "$SRC/hello.txt"
echo "nested" > "$SRC/a/b/nested.txt"
dd if=/dev/urandom of="$SRC/blob.bin" bs=1024 count=16 status=none

echo "[smoke] pushing folder..."
PUSH_OUT="$(run_cli push-folder --server "$BASE" --device smoke --folder "$SRC")"
echo "$PUSH_OUT" | sed -n '1,5p'
SNAPSHOT_ID="$(echo "$PUSH_OUT" | sed -n 's/^snapshot:[[:space:]]*//p' | head -n1)"
if [ -z "$SNAPSHOT_ID" ]; then
  echo "[smoke] could not parse snapshot id from output" >&2
  exit 1
fi
echo "[smoke] snapshot: $SNAPSHOT_ID"

echo "[smoke] listing tree..."
run_cli tree --server "$BASE" --snapshot "$SNAPSHOT_ID" --path "" | sed -n '1,20p'

echo "[smoke] restoring folder..."
run_cli pull-folder --server "$BASE" --snapshot "$SNAPSHOT_ID" --out "$OUT" --concurrency 4 >/dev/null

echo "[smoke] comparing hashes..."
(cd "$SRC" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$TMP/src.sha256"
(cd "$OUT" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$TMP/out.sha256"

diff -u "$TMP/src.sha256" "$TMP/out.sha256" >/dev/null
echo "[smoke] OK"
