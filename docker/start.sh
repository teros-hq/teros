#!/bin/sh
# Start Teros (pulls the release images on first run, builds nothing).
set -eu
cd "$(dirname "$0")/.."
docker compose up -d
echo "Teros is starting. Frontend: http://localhost:${FRONTEND_PORT:-10002}"
