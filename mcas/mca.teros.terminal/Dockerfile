# MCA Terminal Dockerfile
#
# Build from monorepo root:
#   docker build -f mcas/mca.teros.terminal/Dockerfile -t mca-terminal .
#
# Run:
#   docker run -p 3000:3000 mca-terminal
#
# NOTE: the runtime image used in production is the shared
# teros/mca-runtime-bash:latest (see manifest.json dockerImage and
# scripts/build-mca-runtimes.sh). This Dockerfile exists for standalone
# builds/dev of this MCA only.

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# Install bash (parity with the bash runtime image this MCA is deployed on)
RUN apk add --no-cache bash

WORKDIR /app

# Copy shared packages first (for layer caching)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/dist packages/shared/dist

COPY packages/mca-sdk/package.json packages/mca-sdk/
COPY packages/mca-sdk/dist packages/mca-sdk/dist

# Copy MCA
COPY mcas/mca.teros.terminal/package.json ./
COPY mcas/mca.teros.terminal/src ./src

# Install dependencies
RUN npm install --production 2>/dev/null || yarn install --production

# Environment
ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run
CMD ["npx", "tsx", "src/index.ts"]
