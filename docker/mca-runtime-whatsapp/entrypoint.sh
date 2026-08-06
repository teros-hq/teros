#!/bin/bash
set -e

echo "╔════════════════════════════════════════╗"
echo "║   MCA Runtime — WhatsApp (WAHA)        ║"
echo "╚════════════════════════════════════════╝"
echo "📦 MCA ID: ${MCA_ID:-mca.whatsapp}"
echo "🔌 Transport: ${MCA_TRANSPORT:-http}"
echo "🌐 MCA Port: ${MCA_HTTP_PORT:-3000}"
echo "📱 WAHA Port: ${WAHA_PORT:-3001}"
echo ""

# ─────────────────────────────────────────────────────────────────
# Read-only source model (same as mca-runtime base).
#
# /app/mca is mounted READ-ONLY. Everything the runtime needs is BAKED INTO
# THE IMAGE. We copy source into a writable per-container run dir and symlink
# the baked node_modules. No `npm install` at boot.
# ─────────────────────────────────────────────────────────────────

if [ ! -d "/app/mca/src" ] && [ ! -d "/app/mca/mcp" ] && [ ! -d "/app/mca/dist" ]; then
  echo "❌ Error: No MCA mounted at /app/mca"
  exit 1
fi

if [ ! -f "/app/mca/manifest.json" ]; then
  echo "❌ Error: No manifest.json found in /app/mca"
  exit 1
fi

if [ -z "$MCA_ID" ]; then
  MCA_ID=$(node -e "console.log(require('/app/mca/manifest.json').id)")
  export MCA_ID
fi

RUN_DIR="/run/mca"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# Copy MCA source (skip node_modules if present)
shopt -s dotglob
for item in /app/mca/*; do
  base="$(basename "$item")"
  [ "$base" = "node_modules" ] && continue
  cp -a "$item" "$RUN_DIR/"
done
shopt -u dotglob

# node_modules = baked union
if [ ! -d /opt/mca-deps/node_modules ]; then
  echo "❌ Error: baked deps missing at /opt/mca-deps/node_modules (rebuild the image)"
  exit 1
fi
ln -sfn /opt/mca-deps/node_modules "$RUN_DIR/node_modules"

# Resolve entry point (prefer src/index.ts)
if   [ -f "$RUN_DIR/src/index.ts"  ]; then ENTRY="src/index.ts";  RUNNER="tsx"
elif [ -f "$RUN_DIR/mcp/index.ts"  ]; then ENTRY="mcp/index.ts";  RUNNER="tsx"
elif [ -f "$RUN_DIR/dist/index.js" ]; then ENTRY="dist/index.js"; RUNNER="node"
elif [ -f "$RUN_DIR/mcp/index.js"  ]; then ENTRY="mcp/index.js";  RUNNER="node"
else
  echo "❌ Error: No entry point found (src/index.ts, mcp/index.*, dist/index.js)"
  exit 1
fi

# ── Create MCA start script (invoked by supervisord) ──
export RUNNER ENTRY

cat > /start-mca.sh << 'MCAEOF'
#!/bin/bash
WAHA_PORT="${WAHA_PORT:-3001}"

echo "⏳ Waiting for WAHA on port ${WAHA_PORT}..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${WAHA_PORT}/ping" > /dev/null 2>&1; then
    echo "✅ WAHA is ready (attempt ${i})"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "⚠️  WAHA not ready after 120s — starting MCA anyway"
  fi
  sleep 2
done

cd /run/mca
echo "🚀 Starting MCA server: ${RUNNER} ${ENTRY}"
exec ${RUNNER} ${ENTRY}
MCAEOF
chmod +x /start-mca.sh

# ── Start supervisord (WAHA + MCA server) ──
mkdir -p /var/log/supervisor
/usr/bin/supervisord -c /etc/supervisor/supervisord.conf
