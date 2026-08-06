# MCA Runtime Container — Bash Edition (Option A: baked deps, persistent /app-data)
#
# Same baked-deps model as docker/mca-runtime/Dockerfile, but on a Debian
# (glibc) base so users get `apt-get`, and wired for PERSISTENT STATE:
#
#   - The container FS stays ephemeral (recycled on idle). State lives in the
#     bind-mounted /app-data (host {workspace}/.apps/bash) + /workspace.
#   - HOME, npm-global and pip --user all resolve under /app-data, so installs
#     persist as plain files.
#   - apt is wrapped (apt-wrapper.sh): successful installs are recorded and the
#     .debs are cached under /app-data; entrypoint.sh replays that list on boot.
#
# Build (from repo root):
#   docker build -t teros/mca-runtime-bash:latest -f docker/mca-runtime-bash/Dockerfile .
#
# bash has no native deps, so no glibc/musl concern — but the builder toolchain
# is kept in case a baked dep ever needs node-gyp.

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder: bake @teros packages + bash's external deps
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

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

# --- bash's external deps -> /opt/mca-deps/node_modules ---
# A tiny committed manifest (docker/mca-runtime-bash/deps.json) — NOT the
# host-generated union used by the generic runtime, since this image serves
# exactly one MCA.
COPY docker/mca-runtime-bash/deps.json /opt/mca-deps/package.json

RUN cd /opt/mca-deps && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared  node_modules/@teros/shared && \
    ln -sfn /opt/teros-sdk/mca-sdk node_modules/@teros/mca-sdk

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Baseline userland the shell is expected to have out of the box. Anything else
# the user installs later via apt is persisted + replayed (see entrypoint.sh).
# We remove docker-clean so downloaded .debs survive into the persistent cache,
# and snapshot the manual-package baseline the apt wrapper diffs against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client procps jq unzip zip less nano \
      python3 python3-pip python3-venv \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && mkdir -p /etc/teros \
    && apt-mark showmanual | sort > /etc/teros/apt-baseline.txt \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g tsx typescript

WORKDIR /app
RUN mkdir -p /app/mca /workspace

# Baked SDK + deps (COPY preserves the @teros symlinks)
COPY --from=builder /opt/teros-sdk /opt/teros-sdk
COPY --from=builder /opt/mca-deps  /opt/mca-deps

# Base runtime entrypoint (source copy + baked node_modules + tsx launch) is
# reused verbatim; our entrypoint layers persistence bootstrap + apt replay
# before exec'ing it.
COPY docker/mca-runtime/entrypoint.sh       /entrypoint-base.sh
COPY docker/mca-runtime-bash/entrypoint.sh  /entrypoint.sh
COPY docker/mca-runtime-bash/apt-wrapper.sh /usr/local/bin/apt-get
RUN chmod +x /entrypoint.sh /entrypoint-base.sh /usr/local/bin/apt-get && \
    ln -sf /usr/local/bin/apt-get /usr/local/bin/apt

ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production

# Persistence-aware home + package locations. These live under the bind-mounted
# /app-data, so `npm i -g` / `pip install --user` / dotfiles all survive a
# container recycle without any replay step (they're just files).
ENV HOME=/app-data/home
ENV NPM_CONFIG_PREFIX=/app-data/.npm-global
ENV PYTHONUSERBASE=/app-data/.python-user
ENV PIP_USER=1
ENV PATH=/app-data/.npm-global/bin:/app-data/.python-user/bin:/app-data/bin:$PATH

EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
