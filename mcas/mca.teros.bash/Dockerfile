# MCA Bash Dockerfile
# 
# Build from monorepo root:
#   docker build -f mcas/mca.teros.bash/Dockerfile -t mca-bash .
#
# Run:
#   docker run -p 3000:3000 mca-bash

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# Install bash (required for this MCA)
RUN apk add --no-cache bash

WORKDIR /app

# Copy shared packages first (for layer caching)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/dist packages/shared/dist

COPY packages/mca-sdk/package.json packages/mca-sdk/
COPY packages/mca-sdk/dist packages/mca-sdk/dist

RUN cd /app/packages/shared && npm install --omit=dev --no-audit --no-fund
RUN cd /app/packages/mca-sdk && \
  node -e "const p=require('./package.json'); delete p.dependencies['@teros/shared']; require('fs').writeFileSync('package.json',JSON.stringify(p))" && \
  npm install --omit=dev --no-audit --no-fund && \
  mkdir -p node_modules/@teros && \
  ln -s /app/packages/shared node_modules/@teros/shared

# Copy MCA
COPY mcas/mca.teros.bash/package.json ./
COPY mcas/mca.teros.bash/src ./src

# Install dependencies
RUN node -e "const p=require('./package.json'); delete p.dependencies['@teros/mca-sdk']; require('fs').writeFileSync('package.json',JSON.stringify(p))" && \
  npm install --omit=dev --no-audit --no-fund tsx && \
  mkdir -p node_modules/@teros && \
  ln -s /app/packages/mca-sdk node_modules/@teros/mca-sdk && \
  ln -s /app/packages/shared node_modules/@teros/shared && \
  ./node_modules/.bin/tsx -e 'import("@teros/mca-sdk")'

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
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
