#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-up] docker not found" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "[docker-up] docker compose not available" >&2
  exit 1
fi

cd "$ROOT"
echo "[docker-up] starting via deploy/docker-compose.yml"
docker compose -f deploy/docker-compose.yml up --build

