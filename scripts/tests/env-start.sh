#!/usr/bin/env bash
# Start the test environment (MongoDB + backend container)
set -e

cd "$(dirname "$0")/../.."

echo "Starting test environment..."
docker compose -f docker-compose.test.yml up -d --build
echo "Test environment is up."
