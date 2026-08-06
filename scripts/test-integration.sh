#!/usr/bin/env bash
# test-integration.sh
#
# CI wrapper: brings the test environment up, runs all suites, tears it down.
# For local iterative development, manage the environment manually instead:
#
#   docker compose -f docker-compose.test.yml up -d --build
#   docker compose -f docker-compose.test.yml exec backend yarn test
#   docker compose -f docker-compose.test.yml exec backend yarn test:integration
#   docker compose -f docker-compose.test.yml down -v

set -euo pipefail

COMPOSE_FILE="docker-compose.test.yml"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

cleanup() {
  echo ""
  echo "🧹 Tearing down test environment..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "🐳 Building and starting test environment..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo ""
echo "🧪 Running full test suite..."
docker compose -f "$COMPOSE_FILE" exec backend sh -c \
  'bun test tests/unit/ && yarn workspace @teros/backend vitest run && bun test packages/backend/tests/integration/'
