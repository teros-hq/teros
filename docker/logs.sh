#!/bin/sh
# Follow the Teros logs.
#
#   docker/logs.sh                   backend, container-agent and frontend
#   docker/logs.sh mongodb qdrant    only the services you name
#
# The databases are left out by default: MongoDB writes about fifteen lines
# for every health probe (one every ten seconds) and buries the rest.
#
# @spec SHLOG-REQ-1 SHLOG-REQ-2
set -eu
cd "$(dirname "$0")/.."
if [ $# -eq 0 ]; then
  set -- backend container-agent frontend
fi
exec docker compose logs -f --tail=200 "$@"
