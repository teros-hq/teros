#!/bin/bash
cd "$(dirname "$0")/.."
docker compose exec backend \
  npx tsx src/scripts/update-password.ts "$@"
