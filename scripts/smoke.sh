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
need mktemp
need python3

HASH_CMD=()
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD=(shasum -a 256)
else
  echo "[smoke] missing dependency: sha256sum or shasum" >&2
  exit 1
fi

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
touch "$SRC/empty.txt"

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
(cd "$SRC" && find . -type f -print0 | sort -z | xargs -0 "${HASH_CMD[@]}") > "$TMP/src.sha256"
(cd "$OUT" && find . -type f -print0 | sort -z | xargs -0 "${HASH_CMD[@]}") > "$TMP/out.sha256"

diff -u "$TMP/src.sha256" "$TMP/out.sha256" >/dev/null

echo "[smoke] testing ignore file (.filedockignore)..."
SRC2="$TMP/src2"
OUT2="$TMP/out2"
mkdir -p "$SRC2" "$OUT2"
echo "keep" > "$SRC2/keep.txt"
dd if=/dev/urandom of="$SRC2/skip.bin" bs=1024 count=4 status=none
cat > "$SRC2/.filedockignore" <<'EOF'
# ignore binary
skip.bin
EOF

PUSH_OUT2="$(run_cli push-folder --server "$BASE" --device smoke --folder "$SRC2")"
SNAPSHOT_ID2="$(echo "$PUSH_OUT2" | sed -n 's/^snapshot:[[:space:]]*//p' | head -n1)"
if [ -z "$SNAPSHOT_ID2" ]; then
  echo "[smoke] could not parse snapshot id (ignore test)" >&2
  exit 1
fi
run_cli pull-folder --server "$BASE" --snapshot "$SNAPSHOT_ID2" --out "$OUT2" --concurrency 4 >/dev/null
test -f "$OUT2/keep.txt"
test ! -f "$OUT2/skip.bin"

echo "[smoke] testing delete + GC..."
run_cli delete-snapshot --server "$BASE" --snapshot "$SNAPSHOT_ID" >/dev/null
run_cli delete-snapshot --server "$BASE" --snapshot "$SNAPSHOT_ID2" >/dev/null

GC_DRY="$(run_cli gc-chunks --server "$BASE" --dry-run)"
python3 - <<PY
import json, sys
obj=json.loads("""$GC_DRY""")
assert obj["unreferenced_chunks"] >= 1, obj
PY

# Actually delete chunks (cap to keep this bounded even on reused tmp dirs).
run_cli gc-chunks --server "$BASE" --max-delete 100000 >/dev/null
GC_DRY2="$(run_cli gc-chunks --server "$BASE" --dry-run)"
python3 - <<PY
import json, sys
obj=json.loads("""$GC_DRY2""")
assert obj["unreferenced_chunks"] == 0, obj
PY

echo "[smoke] OK"
