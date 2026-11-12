# Multi-stage build for Teros Frontend
# Stage 1: Build the app with Node/Yarn
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Optional build arguments (WEBCFG-REQ-9). The published image is built WITHOUT
# them: the backend URLs are read at serve time from /config.js, which
# docker/20-runtime-config.sh writes from TEROS_BACKEND_URL / TEROS_WS_URL when
# the container starts. When given, they are inlined as the fallback.
ARG EXPO_PUBLIC_WS_URL=
ARG EXPO_PUBLIC_BACKEND_URL=

# Set as environment variables for the build
ENV EXPO_PUBLIC_WS_URL=$EXPO_PUBLIC_WS_URL
ENV EXPO_PUBLIC_BACKEND_URL=$EXPO_PUBLIC_BACKEND_URL

# Copy package files first (for better caching)
COPY package.json yarn.lock ./
COPY packages/app/package.json ./packages/app/
COPY packages/shared/package.json ./packages/shared/
COPY packages/workflows/package.json ./packages/workflows/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/

# Copy MCA package.json files (local workspace dependencies)
COPY mcas/mca.teros.filesystem/package.json ./mcas/mca.teros.filesystem/
COPY mcas/mca.teros.workflows/package.json ./mcas/mca.teros.workflows/
COPY mcas/mca.teros.bash/package.json ./mcas/mca.teros.bash/

# Install dependencies
RUN yarn install --no-frozen-lockfile --ignore-engines

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/app ./packages/app
COPY packages/mca-sdk ./packages/mca-sdk
COPY packages/workflows ./packages/workflows

# Copy MCA source (needed for workspace resolution)
COPY mcas/mca.teros.filesystem ./mcas/mca.teros.filesystem
COPY mcas/mca.teros.workflows ./mcas/mca.teros.workflows
COPY mcas/mca.teros.bash ./mcas/mca.teros.bash

# Build @teros/shared first (generates dist/ needed by the app)
WORKDIR /app/packages/shared
RUN npx tsc --build

# Build the web app
WORKDIR /app/packages/app
ENV NODE_OPTIONS="--max-old-space-size=8192"
RUN yarn build

# Stage 2: Serve with nginx
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

# Copy nginx config
COPY packages/app/nginx.conf /etc/nginx/conf.d/default.conf

# Runtime config: the nginx image runs /docker-entrypoint.d/* before starting.
# Writes /usr/share/nginx/html/config.js from TEROS_BACKEND_URL / TEROS_WS_URL.
COPY --chmod=755 packages/app/docker/20-runtime-config.sh /docker-entrypoint.d/20-runtime-config.sh

# Copy built app from builder stage
COPY --from=builder /app/packages/app/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
