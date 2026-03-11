#!/bin/bash
set -e

echo "╔════════════════════════════════════════╗"
echo "║       MCA Runtime Container            ║"
echo "╚════════════════════════════════════════╝"

# Check if MCA is mounted
if [ ! -d "/app/mca/src" ] && [ ! -d "/app/mca/mcp" ] && [ ! -d "/app/mca/dist" ]; then
  echo "❌ Error: No MCA mounted at /app/mca"
  echo ""
  echo "Usage: docker run -v /path/to/mca:/app/mca teros/mca-runtime"
  exit 1
fi

# Check for manifest
if [ ! -f "/app/mca/manifest.json" ]; then
  echo "❌ Error: No manifest.json found in /app/mca"
  exit 1
fi

# Extract MCA ID from manifest if not provided
if [ -z "$MCA_ID" ]; then
  MCA_ID=$(node -e "console.log(require('/app/mca/manifest.json').id)")
  export MCA_ID
fi

echo "📦 MCA ID: $MCA_ID"
echo "🔌 Transport: $MCA_TRANSPORT"
echo "🌐 Port: $MCA_HTTP_PORT"
echo ""

# ─────────────────────────────────────────────────────────────────
# Build writable shadows for @teros/shared and @teros/mca-sdk.
#
# /sdk-deps has the pre-installed node_modules (baked into the image).
# We copy fresh dist+src from the host mount (/app/packages:ro) on top,
# so containers always run the latest code without a rebuild.
# ─────────────────────────────────────────────────────────────────

echo "📁 Setting up @teros package shadows..."

# --- @teros/shared shadow ---
mkdir -p /tmp/teros-shared
cp -r /sdk-deps/shared/node_modules /tmp/teros-shared/node_modules 2>/dev/null || true
cp -r /app/packages/shared/dist     /tmp/teros-shared/dist 2>/dev/null || true
cp -r /app/packages/shared/src      /tmp/teros-shared/src  2>/dev/null || true
cp    /app/packages/shared/package.json /tmp/teros-shared/package.json 2>/dev/null || true

# --- @teros/mca-sdk shadow ---
mkdir -p /tmp/teros-mca-sdk
cp -r /sdk-deps/mca-sdk/node_modules /tmp/teros-mca-sdk/node_modules 2>/dev/null || true
cp -r /app/packages/mca-sdk/dist     /tmp/teros-mca-sdk/dist 2>/dev/null || true
cp -r /app/packages/mca-sdk/src      /tmp/teros-mca-sdk/src  2>/dev/null || true
cp    /app/packages/mca-sdk/package.json /tmp/teros-mca-sdk/package.json 2>/dev/null || true
# Point mca-sdk's @teros/shared dep to the shared shadow
mkdir -p /tmp/teros-mca-sdk/node_modules/@teros
ln -sfn /tmp/teros-shared /tmp/teros-mca-sdk/node_modules/@teros/shared

# ─────────────────────────────────────────────────────────────────
# Create a writable workspace for the MCA
# ─────────────────────────────────────────────────────────────────
WORK_DIR="/tmp/mca-workspace"
mkdir -p "$WORK_DIR"

echo "📁 Copying MCA source to workspace..."
cp -r /app/mca/* "$WORK_DIR/" 2>/dev/null || true

# Set up node_modules pointing to the shadows
mkdir -p "$WORK_DIR/node_modules/@teros"
ln -sfn /tmp/teros-shared   "$WORK_DIR/node_modules/@teros/shared"
ln -sfn /tmp/teros-mca-sdk  "$WORK_DIR/node_modules/@teros/mca-sdk"

# Install MCA-specific dependencies if package.json exists
if [ -f "$WORK_DIR/package.json" ]; then
  echo "📥 Installing MCA dependencies..."
  cd "$WORK_DIR"
  # Remove @teros/* from dependencies to avoid npm trying to fetch them
  node -e "
    const p=require('./package.json');
    if(p.dependencies) {
      Object.keys(p.dependencies).forEach(k => {
        if(k.startsWith('@teros/')) delete p.dependencies[k];
      });
    }
    require('fs').writeFileSync('package.json', JSON.stringify(p,null,2));
  "
  npm install --omit=dev 2>/dev/null || true
  # Restore @teros symlinks (npm install may have clobbered them)
  mkdir -p node_modules/@teros
  ln -sfn /tmp/teros-shared  node_modules/@teros/shared
  ln -sfn /tmp/teros-mca-sdk node_modules/@teros/mca-sdk
fi

cd "$WORK_DIR"

# Find entry point
ENTRY_POINT=""
if [ -f "src/index.ts" ]; then
  ENTRY_POINT="src/index.ts"
elif [ -f "dist/index.js" ]; then
  ENTRY_POINT="dist/index.js"
elif [ -f "mcp/index.ts" ]; then
  ENTRY_POINT="mcp/index.ts"
elif [ -f "mcp/index.js" ]; then
  ENTRY_POINT="mcp/index.js"
else
  echo "❌ Error: No entry point found (src/index.ts, dist/index.js, mcp/index.ts)"
  exit 1
fi

echo "🚀 Starting MCA with entry point: $ENTRY_POINT"
echo "────────────────────────────────────────"

# Run the MCA
if [[ "$ENTRY_POINT" == *.ts ]]; then
  exec tsx "$ENTRY_POINT"
else
  exec node "$ENTRY_POINT"
fi
