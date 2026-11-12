# Teros Platform — all-in-one image for Railway (dev)
#
# Packages backend (Node/tsx, internal :3000) + frontend static export in one
# container. nginx listens on $PORT (injected by Railway), serves the static
# web bundle, and proxies backend paths + WebSocket upgrades to the backend.
#
# Why a single root Dockerfile: the Teros HQ Railway app has no root-directory
# configuration, and railway.json is repo-wide — per-service Dockerfiles under
# packages/* would not be reliably picked up. A root Dockerfile is the one
# convention Railway auto-detects. Same origin for web + WS = no CORS gymnastics.
#
# Secrets are NOT baked into the image: docker/railway/entrypoint.sh renders
# .secrets/system/*.json from environment variables at container start
# (SecretsManager reads files only — there is no env-var fallback).
#
# Build args (Railway passes service variables as build args to Docker builds):
#   EXPO_PUBLIC_WS_URL        optional, e.g. wss://your-backend.example.com/ws (baked into the web bundle)
#   EXPO_PUBLIC_BACKEND_URL  optional, e.g. https://your-backend.example.com — default: same origin

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Build args for the Expo web export (must be present at build time)
ARG EXPO_PUBLIC_WS_URL=
ARG EXPO_PUBLIC_BACKEND_URL=
ENV EXPO_PUBLIC_WS_URL=$EXPO_PUBLIC_WS_URL \
    EXPO_PUBLIC_BACKEND_URL=$EXPO_PUBLIC_BACKEND_URL

# Build tools for native modules (node-pty, sharp, bcrypt)
RUN apk add --no-cache python3 make g++

# Workspace manifests first (layer caching), then full mcas/ — yarn.lock
# references the MCA workspace packages, so they must exist for resolution.
COPY package.json yarn.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/
COPY packages/testing/package.json ./packages/testing/
COPY packages/app/package.json ./packages/app/
COPY packages/e2e/package.json ./packages/e2e/
COPY packages/workflows/package.json ./packages/workflows/
COPY mcas ./mcas

# --no-frozen-lockfile: yarn.lock has host-absolute paths for local MCAs that
# differ inside Docker; yarn regenerates those entries.
RUN yarn install --no-frozen-lockfile --ignore-engines

# Source code
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/backend ./packages/backend
COPY packages/mca-sdk ./packages/mca-sdk
COPY packages/workflows ./packages/workflows
COPY packages/app ./packages/app
COPY scripts ./scripts

# Build the TS packages in dependency order (same as the compose backend image)
RUN cd packages/shared && yarn build \
 && cd ../core && yarn build \
 && cd ../mca-sdk && yarn build \
 && cd ../workflows && yarn build \
 && cd ../backend && yarn build

# Build the web frontend (static export → packages/app/dist)
WORKDIR /app/packages/app
# Both args are optional (WEBCFG-REQ-9): with nothing set the web bundle talks to
# its own origin, which is exactly this image's layout (nginx proxies /ws and the
# API paths to the backend). Pass them only to point the web at another host.
ENV NODE_OPTIONS="--max-old-space-size=8192"
RUN yarn build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app

# tsx runs the backend + sync scripts. yarn classic already ships in the
# node:20-alpine base image (/usr/local/bin/yarn) — do NOT reinstall it via
# npm (EEXIST on /usr/local/bin/yarn, seen in the first Railway build).
# nginx serves the static frontend and proxies to the backend.
RUN npm install -g tsx && apk add --no-cache nginx

# Built artifacts and dependencies (mirrors packages/backend/Dockerfile)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/src ./packages/shared/src
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/src ./packages/core/src
COPY --from=builder /app/packages/core/package.json ./packages/core/

COPY --from=builder /app/packages/mca-sdk/dist ./packages/mca-sdk/dist
COPY --from=builder /app/packages/mca-sdk/src ./packages/mca-sdk/src
COPY --from=builder /app/packages/mca-sdk/package.json ./packages/mca-sdk/

COPY --from=builder /app/packages/workflows/dist ./packages/workflows/dist
COPY --from=builder /app/packages/workflows/src ./packages/workflows/src
COPY --from=builder /app/packages/workflows/package.json ./packages/workflows/

COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/src ./packages/backend/src
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/backend/static ./packages/backend/static
COPY --from=builder /app/packages/backend/templates ./packages/backend/templates

COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/mcas ./mcas

# Frontend static export served by nginx
COPY --from=builder /app/packages/app/dist /usr/share/nginx/html

# Railway support files
COPY docker/railway/entrypoint.sh /app/docker/railway/entrypoint.sh
COPY docker/railway/nginx.conf.template /app/docker/railway/nginx.conf.template
COPY docker/railway/seed-flags.mjs /app/docker/railway/seed-flags.mjs
RUN chmod +x /app/docker/railway/entrypoint.sh

# Workspace symlinks so @teros/* resolve from the hoisted node_modules
RUN rm -rf node_modules/@teros && \
    mkdir -p node_modules/@teros && \
    ln -s /app/packages/shared node_modules/@teros/shared && \
    ln -s /app/packages/core node_modules/@teros/core && \
    ln -s /app/packages/mca-sdk node_modules/@teros/mca-sdk && \
    ln -s /app/packages/workflows node_modules/@teros/workflows

# Defaults for this image (Railway variables override them at runtime).
# /data is where the Railway volume is mounted (workspaces, uploads, objects).
ENV MCA_BASE_PATH=/app/mcas \
    VOLUMES_BASE_PATH=/data/volumes \
    UPLOADS_PATH=/data/uploads \
    BACKEND_PORT=3000

EXPOSE 3000 8080

ENTRYPOINT ["/app/docker/railway/entrypoint.sh"]
