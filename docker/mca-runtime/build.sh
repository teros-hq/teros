#!/bin/bash
# Build the MCA runtime container image
#
# Usage:
#   ./docker/mca-runtime/build.sh [--no-cache]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "╔════════════════════════════════════════╗"
echo "║   Building MCA Runtime Container       ║"
echo "╚════════════════════════════════════════╝"
echo ""

cd "$PROJECT_ROOT"

# Build shared packages first
echo "📦 Building @teros/shared..."
cd packages/shared
npm run build
cd "$PROJECT_ROOT"

echo "📦 Building @teros/mca-sdk..."
cd packages/mca-sdk
npm run build
cd "$PROJECT_ROOT"

echo ""
echo "🐳 Building Docker image..."

# Build args
BUILD_ARGS=""
if [[ "$1" == "--no-cache" ]]; then
  BUILD_ARGS="--no-cache"
fi

docker build $BUILD_ARGS \
  -t teros/mca-runtime:latest \
  -f docker/mca-runtime/Dockerfile \
  .

echo ""
echo "✅ Build complete: teros/mca-runtime:latest"
echo ""
echo "To test:"
echo "  docker run -p 3000:3000 \\"
echo "    -v \$(pwd)/mcas/mca.teros.bash:/app/mca \\"
echo "    teros/mca-runtime:latest"
