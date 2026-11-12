#!/bin/sh
# Update Teros: fetch the latest compose file and release images, restart.
#
# Images come from ghcr.io (see docker-compose.yml); nothing is built here. Pin
# a version with TEROS_IMAGE_TAG in .env. To run from a modified working tree
# instead, use `docker compose up -d --build`.
set -eu
cd "$(dirname "$0")/.."

if [ -d .git ]; then
  echo "Updating the repository..."
  git pull --ff-only --quiet
fi

echo "Pulling release images..."
docker compose pull
./docker/pull-runtimes.sh

echo "Restarting with the new images..."
docker compose up -d --remove-orphans

echo "Removing superseded images..."
docker image prune -f >/dev/null

echo "Teros updated. Frontend: http://localhost:${FRONTEND_PORT:-10002}"
