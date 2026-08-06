#!/bin/bash
set -e

echo "╔════════════════════════════════════════╗"
echo "║   MCA Runtime Container (K8s mode)     ║"
echo "╚════════════════════════════════════════╝"

# MCA_ID is required in K8s mode — set by KubernetesContainerBackend
if [ -z "$MCA_ID" ]; then
  echo "❌ Error: MCA_ID env var is required"
  exit 1
fi

MCA_DIR="/app/mcas/${MCA_ID}"

if [ ! -d "$MCA_DIR" ]; then
  echo "❌ Error: MCA not found at ${MCA_DIR}"
  echo "Available MCAs:"
  ls /app/mcas/
  exit 1
fi

echo "📦 MCA ID:    $MCA_ID"
echo "📁 MCA Dir:   $MCA_DIR"
echo "🔌 Transport: $MCA_TRANSPORT"
echo "🌐 Port:      $MCA_HTTP_PORT"
echo ""

# ── Wire @teros symlinks directly in the baked MCA dir ───────────────────────
# No copying needed — everything is already in the image.
# Just point @teros/* to the pre-installed SDK packages.

echo "📁 Setting up @teros package shadows..."

mkdir -p "$MCA_DIR/node_modules/@teros"
ln -sfn /sdk-deps/shared  "$MCA_DIR/node_modules/@teros/shared"
ln -sfn /sdk-deps/mca-sdk "$MCA_DIR/node_modules/@teros/mca-sdk"

# Also wire mca-sdk's own @teros/shared dep
mkdir -p /sdk-deps/mca-sdk/node_modules/@teros
ln -sfn /sdk-deps/shared /sdk-deps/mca-sdk/node_modules/@teros/shared

cd "$MCA_DIR"

# ── Find entry point ──────────────────────────────────────────────────────────

ENTRY_POINT=""
if   [ -f "src/index.ts" ];   then ENTRY_POINT="src/index.ts"
elif [ -f "dist/index.js" ];  then ENTRY_POINT="dist/index.js"
elif [ -f "mcp/index.ts" ];   then ENTRY_POINT="mcp/index.ts"
elif [ -f "mcp/index.js" ];   then ENTRY_POINT="mcp/index.js"
else
  echo "❌ Error: No entry point found (src/index.ts, dist/index.js, mcp/index.ts)"
  exit 1
fi

echo "🚀 Starting MCA: $ENTRY_POINT"
echo "────────────────────────────────────────"

if [[ "$ENTRY_POINT" == *.ts ]]; then
  exec tsx "$ENTRY_POINT"
else
  exec node "$ENTRY_POINT"
fi
