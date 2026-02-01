#!/usr/bin/env bash
set -euo pipefail

# Helper to run the agent in dev (via cargo).
# Usage:
#   scripts/agent.sh ./agent.toml

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <config.toml>"
  exit 2
fi

cfg="$1"
exec cargo run -p filedock -- agent --config "$cfg"

