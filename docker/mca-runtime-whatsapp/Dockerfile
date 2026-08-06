# MCA Runtime — WhatsApp (WAHA) Edition (baked deps, read-only source)
#
# Runs WAHA (WhatsApp HTTP API) + the Teros MCA server in the same container.
# WAHA listens on internal port 3001; MCA server on port 3000.
#
# Same model as docker/mca-runtime/Dockerfile: the MCA source is mounted READ-ONLY
# at runtime and everything needed is baked into the image, so container boot does
# no `npm install` and no `cp -r` of node_modules:
#   /opt/teros-sdk/{shared,mca-sdk}  → @teros packages (compiled dist + prod deps)
#   /opt/mca-deps/node_modules       → union of MCA external deps (generic image)
#
# Build (from repo root):
#   docker build -t teros/mca-runtime-whatsapp:latest -f docker/mca-runtime-whatsapp/Dockerfile .

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder: bake @teros packages + the union of MCA deps
# ─────────────────────────────────────────────────────────────────
# @fixme alice - 2026.07.09 : pin to 2026.4.2 — 2026.6.2 has a GOWS SQLite bug (sql: database is closed, GitHub #1503)
FROM devlikeapro/waha-plus:gows-2026.4.2 AS builder

# Toolchain some native modules may need
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# --- @teros/shared and @teros/mca-sdk: build from source ---
COPY packages/shared  /opt/teros-sdk/shared
COPY packages/mca-sdk /opt/teros-sdk/mca-sdk

RUN cd /opt/teros-sdk/shared && \
    npm install --no-audit --no-fund && \
    npm run build && \
    npm prune --omit=dev

RUN cd /opt/teros-sdk/mca-sdk && \
    node -e "const p=require('./package.json'); if(p.dependencies) delete p.dependencies['@teros/shared']; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))" && \
    npm install --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared node_modules/@teros/shared && \
    npm run build && \
    npm prune --omit=dev && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared node_modules/@teros/shared

# --- Union of every MCA's external deps -> /opt/mca-deps/node_modules ---
# The generic union excludes the heavy browser stack; WhatsApp does not need it.
COPY docker/mca-runtime/deps.generated.json /opt/mca-deps/package.json

RUN cd /opt/mca-deps && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared  node_modules/@teros/shared && \
    ln -sfn /opt/teros-sdk/mca-sdk node_modules/@teros/mca-sdk

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
FROM devlikeapro/waha-plus:gows-2026.4.2

RUN apt-get update && apt-get install -y curl supervisor && rm -rf /var/lib/apt/lists/*
RUN npm install -g tsx typescript

WORKDIR /app
RUN mkdir -p /app/mca

# Baked SDK + deps
COPY --from=builder /opt/teros-sdk /opt/teros-sdk
COPY --from=builder /opt/mca-deps  /opt/mca-deps

# Supervisor config + WAHA original entrypoint backup
COPY docker/mca-runtime-whatsapp/supervisord.conf /etc/supervisor/conf.d/teros-whatsapp.conf
RUN cp /entrypoint.sh /waha-entrypoint.sh && chmod +x /waha-entrypoint.sh
COPY docker/mca-runtime-whatsapp/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production
ENV WAHA_PORT=3001
ENV WAHA_API_KEY=changeme
ENV WHATSAPP_DEFAULT_ENGINE=GOWS

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
