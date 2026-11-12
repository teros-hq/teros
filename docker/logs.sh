#!/bin/sh
# Follow the logs of every Teros service (or of the ones given as arguments).
set -eu
cd "$(dirname "$0")/.."
exec docker compose logs -f --tail=200 "$@"
