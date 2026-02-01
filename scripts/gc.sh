#!/usr/bin/env bash
set -euo pipefail

# Simple helper for chunk garbage collection.
# Usage:
#   scripts/gc.sh http://127.0.0.1:8787 [--dry-run] [--max-delete N]
#
# Requires FILEDOCK_TOKEN for auth-enabled servers.

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <server_url> [filedock gc-chunks args...]"
  exit 2
fi

server="$1"
shift

exec cargo run -p filedock -- gc-chunks --server "$server" "$@"

