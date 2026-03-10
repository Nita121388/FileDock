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
  if [ -n "${CLI_MODE:-}" ] && [ "$CLI_MODE" = "cargo" ]; then
    need cargo
    (cd "$ROOT" && FILEDOCK_TOKEN="$TOKEN" cargo run -p filedock -- "$@")
    return
  fi

  if [ -x "$ROOT/target/release/filedock" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/release/filedock" "$@"
    return
  fi
  if [ -x "$ROOT/target/debug/filedock" ]; then
    FILEDOCK_TOKEN="$TOKEN" "$ROOT/target/debug/filedock" "$@"
    return
  fi

  need cargo
  (cd "$ROOT" && FILEDOCK_TOKEN="$TOKEN" cargo run -p filedock -- "$@")
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

echo "[smoke] selecting CLI mode..."

# Prefer using a built CLI binary if it looks compatible. Otherwise fall back to
# `cargo run` so the smoke test doesn't silently exercise a stale debug binary.
CLI_MODE="${CLI_MODE:-bin}"
if [ "$CLI_MODE" = "bin" ]; then
  CLI_BIN=""
  if [ -x "$ROOT/target/release/filedock" ]; then
    CLI_BIN="$ROOT/target/release/filedock"
  elif [ -x "$ROOT/target/debug/filedock" ]; then
    CLI_BIN="$ROOT/target/debug/filedock"
  fi

  if [ -n "$CLI_BIN" ]; then
    if ! "$CLI_BIN" status --help 2>/dev/null | grep -q -- '--include-ignored'; then
      if command -v cargo >/dev/null 2>&1; then
        CLI_MODE="cargo"
      else
        echo "[smoke] filedock binary missing --include-ignored; rebuild or install a newer CLI" >&2
        exit 1
      fi
    fi
    if ! "$CLI_BIN" push-folder --help 2>/dev/null | grep -q -- '--respect-gitignore'; then
      if command -v cargo >/dev/null 2>&1; then
        CLI_MODE="cargo"
      else
        echo "[smoke] filedock binary missing --respect-gitignore; rebuild or install a newer CLI" >&2
        exit 1
      fi
    fi
  fi
fi

echo "[smoke] CLI mode: $CLI_MODE"

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

echo "[smoke] status reasons (ignore_file)..."
STATUS2="$(run_cli status --server "$BASE" --snapshot "$SNAPSHOT_ID2" --folder "$SRC2" --include-ignored)"
python3 - <<PY
import json
items=json.loads("""$STATUS2""")
skip=[x for x in items if x.get("path")=="skip.bin"]
assert skip, items
assert skip[0].get("status")=="ignored", skip[0]
reason=(skip[0].get("reason") or "")
assert "ignore_file" in reason, reason
PY

echo "[smoke] testing .gitignore (--respect-gitignore)..."
SRC3="$TMP/src3"
OUT3="$TMP/out3"
mkdir -p "$SRC3" "$OUT3"
echo "keep" > "$SRC3/keep.txt"
echo "keep" > "$SRC3/keep.log"
echo "skip" > "$SRC3/skip.log"
dd if=/dev/urandom of="$SRC3/skip.bin" bs=1024 count=4 status=none
cat > "$SRC3/.gitignore" <<'EOF'
# ignore binary
skip.bin
# ignore logs but keep one
*.log
!keep.log
EOF

PUSH_OUT3="$(run_cli push-folder --server "$BASE" --device smoke --folder "$SRC3" --respect-gitignore)"
SNAPSHOT_ID3="$(echo "$PUSH_OUT3" | sed -n 's/^snapshot:[[:space:]]*//p' | head -n1)"
if [ -z "$SNAPSHOT_ID3" ]; then
  echo "[smoke] could not parse snapshot id (gitignore test)" >&2
  exit 1
fi
run_cli pull-folder --server "$BASE" --snapshot "$SNAPSHOT_ID3" --out "$OUT3" --concurrency 4 >/dev/null
test -f "$OUT3/keep.txt"
test -f "$OUT3/keep.log"
test ! -f "$OUT3/skip.log"
test ! -f "$OUT3/skip.bin"

echo "[smoke] status reasons (.gitignore)..."
STATUS3="$(run_cli status --server "$BASE" --snapshot "$SNAPSHOT_ID3" --folder "$SRC3" --include-ignored --respect-gitignore)"
python3 - <<PY
import json
items=json.loads("""$STATUS3""")
skip_bin=[x for x in items if x.get("path")=="skip.bin"]
assert skip_bin, items
assert skip_bin[0].get("status")=="ignored", skip_bin[0]
reason=(skip_bin[0].get("reason") or "")
assert ".gitignore" in reason, reason
PY

echo "[smoke] testing delete + GC..."
run_cli delete-snapshot --server "$BASE" --snapshot "$SNAPSHOT_ID" >/dev/null
run_cli delete-snapshot --server "$BASE" --snapshot "$SNAPSHOT_ID2" >/dev/null
run_cli delete-snapshot --server "$BASE" --snapshot "$SNAPSHOT_ID3" >/dev/null

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
