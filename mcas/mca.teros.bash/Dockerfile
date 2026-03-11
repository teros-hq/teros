# MCA Bash Dockerfile
# 
# Build from monorepo root:
#   docker build -f mcas/mca.teros.bash/Dockerfile -t mca-bash .
#
# Run:
#   docker run -p 3000:3000 mca-bash

FROM node:20-alpine

# Install bash (required for this MCA)
RUN apk add --no-cache bash

WORKDIR /app

# Copy shared packages first (for layer caching)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/dist packages/shared/dist

COPY packages/mca-sdk/package.json packages/mca-sdk/
COPY packages/mca-sdk/dist packages/mca-sdk/dist

# Copy MCA
COPY mcas/mca.teros.bash/package.json ./
COPY mcas/mca.teros.bash/src ./src

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
