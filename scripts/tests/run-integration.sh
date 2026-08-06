#!/usr/bin/env bash
# Run integration tests inside the test environment
set -e

cd "$(dirname "$0")/../.."

docker compose -f docker-compose.test.yml exec backend bun test packages/backend/tests/*.test.ts
