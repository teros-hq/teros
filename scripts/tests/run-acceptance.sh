#!/usr/bin/env bash
# Run acceptance tests (Cucumber) inside the test environment
set -e

cd "$(dirname "$0")/../.."

docker compose -f docker-compose.test.yml exec backend yarn workspace @teros/e2e cucumber
