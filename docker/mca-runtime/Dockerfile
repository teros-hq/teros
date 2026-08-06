# MCA Runtime Container — Option A (baked deps, read-only source)
#
# The MCA *source* is still mounted at runtime, but READ-ONLY:
#   docker run -v /opt/teros/mcas/<id>:/app/mca:ro teros/mca-runtime:latest
#
# Everything the runtime needs is BAKED INTO THIS IMAGE, so container boot
# does no `npm install` and no `cp -r` of node_modules:
#   /opt/teros-sdk/{shared,mca-sdk}  → @teros packages (committed dist + prod deps)
#   /opt/mca-deps/node_modules       → union of all MCA external deps (+ @teros symlinks)
#
# Build (from repo root):
#   docker build -t teros/mca-runtime:latest -f docker/mca-runtime/Dockerfile .
#
# NOTE: native deps (@vscode/ripgrep, @resvg/resvg-js, ...) are installed
# INSIDE this Alpine builder so the binaries match the runtime's musl libc.
# The heavy browser stack (playwright/chromium) is intentionally excluded —
# those MCAs run on the dedicated teros/mca-runtime-playwright image.

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder: bake @teros packages + the union of MCA deps
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Toolchain some native modules need to build (node-gyp etc.)
RUN apk add --no-cache python3 make g++ bash

WORKDIR /build

# --- @teros/shared and @teros/mca-sdk: build from source (dist is NOT tracked
# in git, so we compile it here instead of trusting the host's build output) ---
COPY packages/shared  /opt/teros-sdk/shared
COPY packages/mca-sdk /opt/teros-sdk/mca-sdk

# shared: install (with dev, for tsc) → build → prune to prod deps
RUN cd /opt/teros-sdk/shared && \
    npm install --no-audit --no-fund && \
    npm run build && \
    npm prune --omit=dev

# mca-sdk depends on @teros/shared (a workspace file: link that can't resolve
# standalone) → strip it, install the rest, symlink to the built shared, build,
# prune, and restore the symlink (prune may drop it).
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
# The union manifest is generated on the host (scripts/gen-mca-union-deps.mjs,
# invoked by build.sh / deploy-server.sh) and COPYd as a SINGLE file. This keeps
# the (expensive) install layer cached — it only re-runs when a dependency
# actually changes, not on every MCA source edit.
COPY docker/mca-runtime/deps.generated.json /opt/mca-deps/package.json

RUN cd /opt/mca-deps && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared  node_modules/@teros/shared && \
    ln -sfn /opt/teros-sdk/mca-sdk node_modules/@teros/mca-sdk

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache bash curl git openssh-client && rm -rf /var/cache/apk/*
RUN npm install -g tsx typescript

WORKDIR /app
RUN mkdir -p /app/mca

# Baked SDK + deps (with their symlinks preserved: -a keeps symlinks)
COPY --from=builder /opt/teros-sdk /opt/teros-sdk
COPY --from=builder /opt/mca-deps  /opt/mca-deps

COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
