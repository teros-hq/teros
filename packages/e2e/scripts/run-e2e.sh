#!/bin/bash
# E2E Test Runner Script
# 
# This script handles the full e2e test lifecycle:
# 1. Start MongoDB (if not running)
# 2. Start backend in test mode
# 3. Seed test data
# 4. Run tests
# 5. Cleanup

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$(dirname "$E2E_DIR")")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🧪 Teros E2E Test Runner${NC}"
echo "=========================="

# Check if MongoDB e2e container is running
if ! docker ps | grep -q teros-mongodb-e2e; then
    echo -e "${YELLOW}📦 Starting MongoDB for E2E tests...${NC}"
    cd "$E2E_DIR"
    docker compose -f docker-compose.e2e.yml up -d
    sleep 3
else
    echo -e "${GREEN}✓ MongoDB already running${NC}"
fi

# Check if backend is running on port 3002
if curl -s http://localhost:3002/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend already running on port 3002${NC}"
    BACKEND_WAS_RUNNING=true
else
    echo -e "${YELLOW}🚀 Starting backend in test mode...${NC}"
    cd "$PROJECT_ROOT/packages/backend"
    PORT=3002 \
    MONGODB_URI=mongodb://localhost:27018 \
    MONGODB_DATABASE=teros_e2e \
    SESSION_TOKEN_SECRET=e2e-test-secret \
    npx tsx src/index.ts > /tmp/e2e-backend.log 2>&1 &
    BACKEND_PID=$!
    BACKEND_WAS_RUNNING=false
    
    # Wait for backend to be ready
    echo -n "   Waiting for backend"
    for i in {1..30}; do
        if curl -s http://localhost:3002/health > /dev/null 2>&1; then
            echo -e " ${GREEN}ready!${NC}"
            break
        fi
        echo -n "."
        sleep 1
    done
    
    if ! curl -s http://localhost:3002/health > /dev/null 2>&1; then
        echo -e " ${RED}failed!${NC}"
        echo "Backend log:"
        tail -50 /tmp/e2e-backend.log
        exit 1
    fi
fi

# Seed test data
echo -e "${YELLOW}🌱 Seeding test data...${NC}"
cd "$E2E_DIR"
npx tsx src/scripts/seed-test-data.ts

# Run tests
echo -e "${YELLOW}🧪 Running E2E tests...${NC}"
echo ""
yarn test
TEST_EXIT_CODE=$?

# Cleanup
if [ "$BACKEND_WAS_RUNNING" = false ] && [ -n "$BACKEND_PID" ]; then
    echo -e "${YELLOW}🧹 Stopping test backend...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
fi

# Summary
echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ All E2E tests passed!${NC}"
else
    echo -e "${RED}❌ Some E2E tests failed${NC}"
fi

exit $TEST_EXIT_CODE
