# MCA Runtime — Docker Env variant
#
# Extends the base mca-runtime with Docker CLI + docker compose plugin + git.
# Used exclusively for mca.teros.docker-env.
#
# Phase 1 (PoC): Docker socket is mounted at runtime.
# Phase 2: Will switch to Tecnativa docker-socket-proxy.
#
# Build from monorepo root:
#   docker build -t teros/mca-runtime-docker-env:latest \
#     -f docker/mca-runtime-docker-env/Dockerfile .

FROM node:20-alpine

# Install Docker CLI, compose plugin, git, bash, curl
RUN apk add --no-cache \
    bash \
    curl \
    git \
    openssh-client \
    docker-cli \
    docker-cli-compose \
    && rm -rf /var/cache/apk/*

# Install global tools
RUN npm install -g tsx typescript

WORKDIR /app

# ─────────────────────────────────────────────────────────────────
# Install @teros/shared (include src for tsx compatibility)
# ─────────────────────────────────────────────────────────────────
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/shared/dist packages/shared/dist

RUN cd packages/shared && npm install --omit=dev 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────
# Install @teros/mca-sdk (include src for tsx compatibility)
# ─────────────────────────────────────────────────────────────────
COPY packages/mca-sdk/package.json packages/mca-sdk/
COPY packages/mca-sdk/tsconfig.json packages/mca-sdk/
COPY packages/mca-sdk/src packages/mca-sdk/src
COPY packages/mca-sdk/dist packages/mca-sdk/dist

RUN cd packages/mca-sdk && \
    node -e " \
      const p=require('./package.json'); \
      if(p.dependencies) delete p.dependencies['@teros/shared']; \
      require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)) \
    " && \
    npm install --omit=dev 2>/dev/null || true && \
    mkdir -p node_modules/@teros && \
    ln -sf /app/packages/shared node_modules/@teros/shared

# ─────────────────────────────────────────────────────────────────
# Pre-install MCA-specific dependencies into /app/node_modules so
# they are available to tsx at runtime without needing network access.
# ─────────────────────────────────────────────────────────────────
RUN mkdir -p /app/node_modules && \
    npm install --prefix /app mongodb@6 --omit=dev --no-save 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────
# MCA Directory (mounted at runtime)
# ─────────────────────────────────────────────────────────────────
RUN mkdir -p /app/mca

# Copy entrypoint script (reuse from base runtime)
COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production
ENV DOCKER_HOST=unix:///var/run/docker.sock
ENV DOCKER_ENV_BASE_DIR=/tmp/teros-envs
# DOCKER_ENV_DOMAIN must be set at runtime (e.g. envs.yourdomain.com)

# Create envs workdir
RUN mkdir -p /tmp/teros-envs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
