#!/bin/bash
set -e
cd "$(dirname "$0")/.."
if [ ! -r .env ]; then
  echo "  ✗  .env file is missing or not readable"
  exit 1
fi
source .env
[ -z "$APP_URL" ] && echo "  ✗  APP_URL is not set in .env" && exit 1
docker compose up -d
echo "  ✓  Teros started → ${APP_URL}"
