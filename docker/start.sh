#!/bin/bash
set -e
cd "$(dirname "$0")/.."
source .env
[ -z "$APP_URL" ] && echo "  ✗  APP_URL is not set in .env" && exit 1
docker compose up -d
echo "  ✓  Teros started → ${APP_URL}"
