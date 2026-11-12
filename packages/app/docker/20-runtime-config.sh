#!/bin/sh
# Writes /config.js from the container environment before nginx starts
# (the nginx image runs every executable in /docker-entrypoint.d/).
# The web bundle reads window.__TEROS_CONFIG__ before anything else, so one
# image serves any deployment. WEBCFG-REQ-7.
set -eu

json_string() {
  # Escape backslashes and double quotes so a value can never break out of
  # the string literal. URLs carry no other characters that need escaping.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

OUT=${TEROS_CONFIG_OUT:-/usr/share/nginx/html/config.js}
BACKEND=$(json_string "${TEROS_BACKEND_URL:-}")
WS=$(json_string "${TEROS_WS_URL:-}")

printf 'window.__TEROS_CONFIG__={backendUrl:"%s",wsUrl:"%s"};\n' "$BACKEND" "$WS" > "$OUT"
echo "runtime-config: backendUrl=\"${TEROS_BACKEND_URL:-}\" wsUrl=\"${TEROS_WS_URL:-}\" -> $OUT"
