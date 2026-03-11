# mca.teros.docker-env Dockerfile
#
# Phase 1 (PoC): Docker socket is mounted at runtime — no proxy needed.
# Phase 2 (MVP): Will use Tecnativa docker-socket-proxy instead.
#
# Build from monorepo root:
#   docker build -f mcas/mca.teros.docker-env/Dockerfile -t mca-docker-env .
#
# Run (Phase 1 — socket mount):
#   docker run -p 3000:3000 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -e DOCKER_HOST=unix:///var/run/docker.sock \
#     mca-docker-env

FROM node:20-alpine

# Install Docker CLI, docker compose plugin, git, bash
RUN apk add --no-cache \
    bash \
    git \
    curl \
    docker-cli \
    docker-cli-compose

WORKDIR /app

# Copy shared packages at the exact path the symlink resolves to:
# package.json says "file:../../packages/mca-sdk", WORKDIR is /app,
# so npm creates node_modules/@teros/mca-sdk -> ../../../packages/mca-sdk
# which resolves to /packages/mca-sdk (three levels up from /app/node_modules/@teros/mca-sdk).
COPY packages/shared/package.json /packages/shared/
COPY packages/shared/dist /packages/shared/dist

COPY packages/mca-sdk/package.json /packages/mca-sdk/
COPY packages/mca-sdk/dist /packages/mca-sdk/dist

# Copy MCA
COPY mcas/mca.teros.docker-env/package.json ./
COPY mcas/mca.teros.docker-env/src ./src

# Install dependencies + tsx globally (avoids npx downloading it at runtime)
RUN npm install --production 2>/dev/null || yarn install --production && \
    npm install -g tsx

# Install all transitive deps of @teros/mca-sdk and @teros/shared into /app/node_modules.
# We do this by temporarily adding them as direct deps and running npm install from /app.
# This ensures ws, uuid, zod, @modelcontextprotocol/sdk etc. end up in /app/node_modules.
RUN node -e " \
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('/app/package.json','utf8')); \
  const sdkDeps = JSON.parse(fs.readFileSync('/packages/mca-sdk/package.json','utf8')).dependencies || {}; \
  const sharedDeps = JSON.parse(fs.readFileSync('/packages/shared/package.json','utf8')).dependencies || {}; \
  const merged = {...sdkDeps, ...sharedDeps, ...pkg.dependencies}; \
  delete merged['@teros/shared']; delete merged['@teros/mca-sdk']; \
  pkg.dependencies = merged; \
  fs.writeFileSync('/app/package.json', JSON.stringify(pkg, null, 2)); \
" && npm install --production 2>/dev/null || true

# Replace the broken symlinks with real copies so Node.js ESM resolution works.
RUN rm -rf /app/node_modules/@teros/mca-sdk && \
    cp -r /packages/mca-sdk /app/node_modules/@teros/mca-sdk && \
    rm -rf /app/node_modules/@teros/shared && \
    cp -r /packages/shared /app/node_modules/@teros/shared && \
    rm -rf /app/node_modules/@teros/mca-sdk/node_modules \
           /app/node_modules/@teros/shared/node_modules 2>/dev/null || true

# Create the envs working directory
RUN mkdir -p /tmp/teros-envs

# Environment
ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV NODE_ENV=production
ENV DOCKER_HOST=unix:///var/run/docker.sock
ENV DOCKER_ENV_BASE_DIR=/tmp/teros-envs
# DOCKER_ENV_DOMAIN must be set at runtime (e.g. envs.yourdomain.com)

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run
CMD ["tsx", "src/index.ts"]
