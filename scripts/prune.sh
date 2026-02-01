#!/usr/bin/env bash
set -euo pipefail

# Simple helper for snapshot retention.
# Usage:
#   scripts/prune.sh http://127.0.0.1:8787 --keep-last 20 --keep-days 30 [--dry-run]

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <server_url> [filedock prune-snapshots args...]"
  exit 2
fi

server="$1"
shift

exec cargo run -p filedock -- prune-snapshots --server "$server" "$@"

