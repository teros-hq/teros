#!/bin/bash
set -e

echo "╔════════════════════════════════════════╗"
echo "║       MCA Runtime Container            ║"
echo "╚════════════════════════════════════════╝"

# ─────────────────────────────────────────────────────────────────
# Read-only source model (Option A).
#
# /app/mca is mounted READ-ONLY: no container may ever mutate it, so a
# write from one user's session can never leak to another user running
# the same MCA. Everything the runtime needs is BAKED INTO THE IMAGE:
#
#   /opt/teros-sdk/{shared,mca-sdk}   → @teros packages (dist + deps)
#   /opt/mca-deps/node_modules        → union of all MCA external deps,
#                                        built on Alpine (correct libc),
#                                        includes @teros/* symlinks
#
# So the boot does NO `npm install` and NO `cp -r` of node_modules — just
# a handful of symlinks into a per-container run dir. This is what removes
# the CPU/IO spikes caused by mass container startup.
# ─────────────────────────────────────────────────────────────────

# Check if MCA is mounted
if [ ! -d "/app/mca/src" ] && [ ! -d "/app/mca/mcp" ] && [ ! -d "/app/mca/dist" ]; then
  echo "❌ Error: No MCA mounted at /app/mca"
  echo "Usage: docker run -v /path/to/mca:/app/mca:ro teros/mca-runtime"
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

# ─────────────────────────────────────────────────────────────────
# Assemble a writable per-container run dir.
#
# The MCA source is COPIED (not symlinked): Node resolves a symlinked
# entry back to its real path (/app/mca) and would then pick up the
# read-only, incomplete /app/mca/node_modules instead of our baked deps.
# Copying makes /run/mca the real path, so module resolution uses the
# baked node_modules below. Only source is copied (small); node_modules
# is never copied — that's the whole point of baking it into the image.
# Nothing under /app/mca is ever written.
# ─────────────────────────────────────────────────────────────────
RUN_DIR="/run/mca"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# Copy the MCA's own files/dirs (src, dist, static, manifest.json, ...).
# node_modules is intentionally skipped — we provide the baked one below.
shopt -s dotglob
for item in /app/mca/*; do
  base="$(basename "$item")"
  [ "$base" = "node_modules" ] && continue
  cp -a "$item" "$RUN_DIR/"
done
shopt -u dotglob

# node_modules = baked union (already contains @teros/shared + @teros/mca-sdk).
if [ ! -d /opt/mca-deps/node_modules ]; then
  echo "❌ Error: baked deps missing at /opt/mca-deps/node_modules (rebuild the image)"
  exit 1
fi
ln -sfn /opt/mca-deps/node_modules "$RUN_DIR/node_modules"

cd "$RUN_DIR"

# ─────────────────────────────────────────────────────────────────
# Resolve entry point. Prefer running TypeScript source via tsx: the
# dist/ bundles some MCAs ship on disk are stale/broken (e.g. esbuild
# CJS-in-ESM output that throws "__require is not a function"), so src
# is the reliable path. A future build phase can produce trustworthy
# dist and flip this preference.
# ─────────────────────────────────────────────────────────────────
if   [ -f "src/index.ts"  ]; then ENTRY="src/index.ts";  RUNNER="tsx"
elif [ -f "mcp/index.ts"  ]; then ENTRY="mcp/index.ts";  RUNNER="tsx"
elif [ -f "dist/index.js" ]; then ENTRY="dist/index.js"; RUNNER="node"
elif [ -f "mcp/index.js"  ]; then ENTRY="mcp/index.js";  RUNNER="node"
else
  echo "❌ Error: No entry point found (src/index.ts, mcp/index.*, dist/index.js)"
  exit 1
fi

echo "🚀 Starting MCA: $RUNNER $ENTRY"
echo "────────────────────────────────────────"
exec "$RUNNER" "$ENTRY"
