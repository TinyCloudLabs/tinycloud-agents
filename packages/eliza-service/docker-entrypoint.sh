#!/bin/sh
# Phala CVMs inject secrets as ENCRYPTED ENV VARS, not files — but the runtime
# loads the agent key from a FILE (TINYCLOUD_AGENT_KEY_FILE; see runtime-host.ts).
# Bridge the two: if TINYCLOUD_AGENT_KEY is provided as an env var and the key
# file isn't already present (e.g. a bind-mount), materialize it to the file path
# the runtime expects, then drop the var from the env so it isn't inherited
# pre-boot (the runtime re-exports it for child runtimes after reading the file).
set -e

KEY_PATH="${TINYCLOUD_AGENT_KEY_FILE:-/run/secrets/agent.key}"

if [ -n "${TINYCLOUD_AGENT_KEY:-}" ] && [ ! -s "$KEY_PATH" ]; then
  mkdir -p "$(dirname "$KEY_PATH")"
  # printf (not echo) to avoid a trailing newline corrupting the hex key.
  printf '%s' "$TINYCLOUD_AGENT_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  export TINYCLOUD_AGENT_KEY_FILE="$KEY_PATH"
  unset TINYCLOUD_AGENT_KEY
fi

exec "$@"
