#!/usr/bin/env bash
set -euo pipefail

LISTEN_PORT="${LETTA_LISTEN_PORT:-4500}"
TOKEN_FILE="${LETTA_WS_TOKEN_FILE:-/tmp/letta-ws-token}"

if [[ -n "${LETTA_WS_TOKEN:-}" ]]; then
  umask 077
  printf '%s\n' "$LETTA_WS_TOKEN" > "$TOKEN_FILE"
  unset LETTA_WS_TOKEN
fi

if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "ERROR: LETTA_WS_TOKEN or non-empty LETTA_WS_TOKEN_FILE is required" >&2
  exit 1
fi

exec letta server \
  --listen "ws://0.0.0.0:${LISTEN_PORT}" \
  --ws-auth capability-token \
  --ws-token-file "$TOKEN_FILE"
