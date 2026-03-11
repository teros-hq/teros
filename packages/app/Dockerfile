# Multi-stage build for Teros Frontend
# Stage 1: Build the app with Node/Yarn
FROM node:20-alpine AS builder

WORKDIR /app

# Build arguments for environment variables (injected at build time)
# These MUST be provided — no defaults to prevent accidental production usage
ARG EXPO_PUBLIC_WS_URL
ARG EXPO_PUBLIC_BACKEND_URL

# Set as environment variables for the build
ENV EXPO_PUBLIC_WS_URL=$EXPO_PUBLIC_WS_URL
ENV EXPO_PUBLIC_BACKEND_URL=$EXPO_PUBLIC_BACKEND_URL

# Copy package files first (for better caching)
COPY package.json yarn.lock ./
COPY packages/app/package.json ./packages/app/
COPY packages/shared/package.json ./packages/shared/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/

# Copy MCA package.json files (local workspace dependencies)
COPY mcas/mca.teros.filesystem/package.json ./mcas/mca.teros.filesystem/
COPY mcas/mca.teros.bash/package.json ./mcas/mca.teros.bash/

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/app ./packages/app
COPY packages/mca-sdk ./packages/mca-sdk

# Copy MCA source (needed for workspace resolution)
COPY mcas/mca.teros.filesystem ./mcas/mca.teros.filesystem
COPY mcas/mca.teros.bash ./mcas/mca.teros.bash

# Validate required build args
RUN if [ -z "$EXPO_PUBLIC_WS_URL" ]; then echo "ERROR: EXPO_PUBLIC_WS_URL is required" && exit 1; fi && \
    if [ -z "$EXPO_PUBLIC_BACKEND_URL" ]; then echo "ERROR: EXPO_PUBLIC_BACKEND_URL is required" && exit 1; fi

# Build @teros/shared first (generates dist/ needed by the app)
WORKDIR /app/packages/shared
RUN npx tsc --build

# Build the web app
WORKDIR /app/packages/app
RUN yarn build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy nginx config
COPY packages/app/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built app from builder stage
COPY --from=builder /app/packages/app/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
