#!/bin/bash
set -uo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# MCA Test Runner — convenience CLI around bun test
#
# Docker lifecycle (image build, compose up/down) is handled by
# createMcaTestEnv() in the library. This script just loads env,
# resolves test files, and invokes bun test.
#
# Usage:
#   test-mca.sh <mca-id>                 # all tests
#   test-mca.sh <mca-id> --unit          # unit only (no Docker)
#   test-mca.sh <mca-id> --smoke         # smoke only (no credentials needed)
#   test-mca.sh <mca-id> --integration   # integration only (needs .env.test)
#   test-mca.sh <mca-id> --quality-gates     # quality gates (single MCA)
#   test-mca.sh --list
# ─────────────────────────────────────────────────────────────────────────────

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
export REPO_ROOT

COMPOSE_FILE="$PKG_DIR/docker-compose.yml"
PROJECT_NAME="teros-mca-test"

# Load test credentials from .env.test if present
if [ -f "$PKG_DIR/.env.test" ]; then
  set -a
  source "$PKG_DIR/.env.test"
  set +a
fi

# Quality Gate tests handled after MCA_ID is parsed (needs the ID)

if [ "${1:-}" = "--list" ]; then
  echo "MCAs with test suites:"
  echo ""
  find "$REPO_ROOT/mcas" -path "*/test/unit/*.test.ts" -exec basename {} \; \
    | sort -u \
    | while read -r file; do
        echo "  [unit]        $file"
      done
  find "$REPO_ROOT/mcas" -path "*/test/integration/*.test.ts" -exec basename {} \; \
    | sort -u \
    | while read -r file; do
        if echo "$file" | grep -q '\.smoke\.'; then
          echo "  [smoke]       $file"
        else
          echo "  [integration] $file"
        fi
      done
  exit 0
fi

# Parse arguments
TEST_FILTER=""
MCA_ID=""
for arg in "$@"; do
  case "$arg" in
    --unit)        TEST_FILTER="unit" ;;
    --smoke)       TEST_FILTER="smoke" ;;
    --integration) TEST_FILTER="integration" ;;
    --quality-gates)   TEST_FILTER="quality-gates" ;;
    --*)           echo "Unknown flag: $arg"; exit 1 ;;
    *)             MCA_ID="$arg" ;;
  esac
done

if [ -z "$MCA_ID" ]; then
  echo "Usage: test-mca.sh <mca-id> [--unit|--smoke|--integration|--quality-gates]"
  echo "       test-mca.sh --list"
  exit 1
fi

MCA_DIR="$REPO_ROOT/mcas/$MCA_ID"
UNIT_DIR="$MCA_DIR/test/unit"
INTEGRATION_DIR="$MCA_DIR/test/integration"

if [ ! -d "$MCA_DIR" ]; then
  echo "Error: MCA directory not found: $MCA_DIR"
  exit 1
fi

# Quality gates: scoped to a single MCA
if [ "$TEST_FILTER" = "quality-gates" ]; then
  echo "╔════════════════════════════════════════════╗"
  echo "║  MCA Quality Gate Tests                    ║"
  echo "╠════════════════════════════════════════════╣"
  echo "║  MCA:      $MCA_ID"
  echo "║  Criteria: C1-C17 (structural, code,       ║"
  echo "║            output, protocol, consistency)   ║"
  echo "╚════════════════════════════════════════════╝"
  echo ""
  MCA_ID="$MCA_ID" bun test "$PKG_DIR/src/quality-gates/"
  exit $?
fi

# Unit tests: no Docker needed, run and exit early
if [ "$TEST_FILTER" = "unit" ]; then
  if [ ! -d "$UNIT_DIR" ]; then
    echo "No unit tests found for $MCA_ID — skipping."
    exit 0
  fi
  echo "╔════════════════════════════════════════════╗"
  echo "║  MCA Test Runner                           ║"
  echo "╠════════════════════════════════════════════╣"
  echo "║  MCA:      $MCA_ID"
  echo "║  Filter:   unit"
  echo "║  Tests:    $UNIT_DIR"
  echo "╚════════════════════════════════════════════╝"
  echo ""
  echo "▶ Running unit tests (no Docker)..."
  echo ""
  bun test "$UNIT_DIR" || exit $?
  exit 0
fi

if [ ! -d "$INTEGRATION_DIR" ] && [ "$TEST_FILTER" != "" ]; then
  echo "No ${TEST_FILTER} tests found for $MCA_ID — skipping."
  exit 0
fi

# Determine compose profiles based on MCA
PROFILES=""
case "$MCA_ID" in
  mca.teros.memory) PROFILES="--profile qdrant" ;;
esac

# Safety-net teardown — catches crashed test processes that skip afterAll
teardown() {
  echo ""
  echo "▶ Safety-net teardown..."
  REPO_ROOT="$REPO_ROOT" MCA_ID="$MCA_ID" docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" $PROFILES down -v 2>/dev/null || true
}
trap teardown EXIT

echo "╔════════════════════════════════════════════╗"
echo "║  MCA Test Runner                           ║"
echo "╠════════════════════════════════════════════╣"
echo "║  MCA:      $MCA_ID"
echo "║  Filter:   ${TEST_FILTER:-all}"
echo "║  Profiles: ${PROFILES:-none}"
echo "╚════════════════════════════════════════════╝"
echo ""

# Run unit tests first when no filter (bail before Docker on failure)
EXIT_CODE=0
if [ -z "$TEST_FILTER" ] && [ -d "$UNIT_DIR" ]; then
  echo "▶ Running unit tests..."
  bun test "$UNIT_DIR" || EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ]; then
    echo ""
    echo "✗ Unit tests failed — skipping Docker tests."
    exit $EXIT_CODE
  fi
  echo ""
fi

# Check if Docker tests exist before proceeding
if [ -z "$TEST_FILTER" ] && [ ! -d "$INTEGRATION_DIR" ]; then
  echo "▶ No integration tests found — done."
  exit $EXIT_CODE
fi

# Resolve test files
case "$TEST_FILTER" in
  smoke)
    TEST_FILES=$(find "$INTEGRATION_DIR" -name "*.smoke.test.ts" 2>/dev/null)
    if [ -z "$TEST_FILES" ]; then
      echo "No smoke tests found for $MCA_ID — skipping."
      exit 0
    fi
    echo "▶ Running smoke tests only..."
    ;;
  integration)
    TEST_FILES=$(find "$INTEGRATION_DIR" -name "*.integration.test.ts" 2>/dev/null)
    if [ -z "$TEST_FILES" ]; then
      echo "No integration tests found for $MCA_ID — skipping."
      exit 0
    fi
    echo "▶ Running integration tests only (requires credentials)..."
    ;;
  *)
    TEST_FILES="$INTEGRATION_DIR"
    echo "▶ Running Docker-based tests..."
    ;;
esac

echo ""
# shellcheck disable=SC2086
bun test $TEST_FILES || EXIT_CODE=$?

# Dump logs on failure
if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "▶ Tests failed. Container logs:"
  echo "────────────────────────────────────────────"
  REPO_ROOT="$REPO_ROOT" MCA_ID="$MCA_ID" docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" $PROFILES logs --tail=50 || true
  echo "────────────────────────────────────────────"
fi

# Teardown happens via trap
exit $EXIT_CODE
