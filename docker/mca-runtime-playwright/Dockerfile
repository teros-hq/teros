# MCA Runtime Container — Playwright Edition (Option A: baked deps, read-only source)
#
# Same model as docker/mca-runtime/Dockerfile, on the Playwright base image
# (Ubuntu/glibc, bundled browsers). The MCA source is mounted READ-ONLY at
# runtime; everything needed is baked into the image, so container boot does
# no `npm install` and no `cp -r` of node_modules:
#   /opt/teros-sdk/{shared,mca-sdk}  → @teros packages (compiled dist + prod deps)
#   /opt/mca-deps/node_modules       → FULL union of MCA deps (incl. the browser
#                                        stack that the generic image excludes)
#
# Build (from repo root):
#   docker build -t teros/mca-runtime-playwright:latest -f docker/mca-runtime-playwright/Dockerfile .
#
# Native deps are installed on this same glibc base, so binaries match at runtime.

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder: bake @teros packages + the full union of MCA deps
# ─────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS builder

# Toolchain some native modules need to build (node-gyp etc.)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# --- @teros/shared and @teros/mca-sdk: build from source (dist is NOT tracked
# in git, so we compile it here instead of trusting the host's build output) ---
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

# --- Full union of MCA deps (incl. browser stack) -> /opt/mca-deps/node_modules ---
# Generated on the host by scripts/gen-mca-union-deps.mjs (COPYd as a single file
# so this install layer only re-runs when a dependency changes). Browsers are
# already in the base image, so skip re-downloading them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY docker/mca-runtime-playwright/deps.generated.json /opt/mca-deps/package.json

RUN cd /opt/mca-deps && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared  node_modules/@teros/shared && \
    ln -sfn /opt/teros-sdk/mca-sdk node_modules/@teros/mca-sdk

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.1-noble

RUN apt-get update && apt-get install -y curl git openssh-client && rm -rf /var/lib/apt/lists/*
RUN npm install -g tsx typescript

WORKDIR /app
RUN mkdir -p /app/mca

# Baked SDK + deps (COPY preserves the @teros symlinks)
COPY --from=builder /opt/teros-sdk /opt/teros-sdk
COPY --from=builder /opt/mca-deps  /opt/mca-deps

# Same entrypoint as the base runtime
COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
