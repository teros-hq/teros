#!/usr/bin/env bash
# Stop and remove the test environment
set -e

cd "$(dirname "$0")/../.."

echo "Stopping test environment..."
docker compose -f docker-compose.test.yml down -v
echo "Test environment stopped."
