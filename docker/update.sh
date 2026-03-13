#!/bin/bash
set -e
cd "$(dirname "$0")/.."
source .env
[ -z "$APP_URL" ] && echo "  ✗  APP_URL is not set in .env" && exit 1
echo "  →  Pulling latest changes..."
git pull
echo "  →  Rebuilding containers..."
docker compose up -d --build
echo "  ✓  Teros updated → ${APP_URL}"
