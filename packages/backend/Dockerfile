# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools required for native modules (node-pty, etc.)
RUN apk add --no-cache python3 make g++

# Copy workspace root files
COPY package.json yarn.lock ./

# Copy only the package.json files needed to resolve the workspace
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/
COPY packages/testing/package.json ./packages/testing/
COPY packages/app/package.json ./packages/app/
COPY packages/e2e/package.json ./packages/e2e/

# Stub out MCA package.json files so yarn workspace resolution works
# (yarn.lock references them but we don't need their deps in the backend image)
COPY mcas ./mcas

# Install all workspace dependencies
# --no-frozen-lockfile: yarn.lock has host-absolute paths for local MCAs that
# differ inside Docker; we let yarn regenerate those entries.
RUN yarn install --no-frozen-lockfile --ignore-engines

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/backend ./packages/backend
COPY packages/mca-sdk ./packages/mca-sdk
COPY packages/testing ./packages/testing
COPY scripts ./scripts

# Build shared package first
WORKDIR /app/packages/shared
RUN yarn build

# Build core package
WORKDIR /app/packages/core
RUN yarn build

# Build mca-sdk package
WORKDIR /app/packages/mca-sdk
RUN yarn build

# Build backend
WORKDIR /app/packages/backend
RUN yarn build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install tsx globally for running TypeScript
RUN npm install -g tsx

# docker CLI: the container-agent launches MCA containers with `docker run` over the
# mounted socket, and the backend shells into them with `docker exec` for the terminal
# window. The base node:20-alpine image ships neither, so both would fail without this.
RUN apk add --no-cache docker-cli

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy shared package (compiled + source for resolution)
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/src ./packages/shared/src
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Copy core package (compiled + source for resolution)
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/src ./packages/core/src
COPY --from=builder /app/packages/core/package.json ./packages/core/

# Copy mca-sdk package (compiled + source for resolution)
COPY --from=builder /app/packages/mca-sdk/dist ./packages/mca-sdk/dist
COPY --from=builder /app/packages/mca-sdk/src ./packages/mca-sdk/src
COPY --from=builder /app/packages/mca-sdk/package.json ./packages/mca-sdk/

# Copy backend package (compiled + source for sync scripts)
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/src ./packages/backend/src
COPY --from=builder /app/packages/backend/package.json ./packages/backend/

# Copy root scripts needed for sync
COPY --from=builder /app/scripts ./scripts

# Copy MCAs (needed for MCA boot sync and tool definitions)
COPY --from=builder /app/mcas ./mcas

# Fix workspace symlinks - remove old ones and create correct absolute symlinks
RUN rm -rf node_modules/@teros && \
    mkdir -p node_modules/@teros && \
    ln -s /app/packages/shared node_modules/@teros/shared && \
    ln -s /app/packages/core node_modules/@teros/core && \
    ln -s /app/packages/mca-sdk node_modules/@teros/mca-sdk

# Set working directory to backend
WORKDIR /app/packages/backend

# Expose WebSocket port
EXPOSE 3000

# Health check (start_period gives time for sync scripts before first check)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start backend server
CMD ["yarn", "start"]
