#!/bin/sh
# Stop Teros. Data (MongoDB, Qdrant, workspaces) stays in the Docker volumes
# and in ./data; `docker compose down -v` would delete the databases.
set -eu
cd "$(dirname "$0")/.."
docker compose down
