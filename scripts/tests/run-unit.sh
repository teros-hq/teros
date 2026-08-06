#!/usr/bin/env bash
# Run unit tests inside the test environment
set -e

cd "$(dirname "$0")/../.."

docker compose -f docker-compose.test.yml exec backend bun test tests/unit/
