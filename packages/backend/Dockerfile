# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json yarn.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/

# Install dependencies for entire workspace
RUN yarn install --frozen-lockfile

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/backend ./packages/backend
COPY packages/mca-sdk ./packages/mca-sdk
COPY scripts ./scripts
COPY mcas ./mcas

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

# Install MCA dependencies
WORKDIR /app
RUN for mca_dir in mcas/*/; do \
      if [ -f "${mca_dir}package.json" ]; then \
        echo "Installing dependencies for ${mca_dir}..." && \
        cd "/app/${mca_dir}" && \
        yarn install --frozen-lockfile || yarn install && \
        cd /app; \
      fi; \
    done

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install tsx globally for running TypeScript
RUN npm install -g tsx

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

# Copy MCAs from builder (includes installed dependencies via hoisting)
# In production, this can be overridden with a volume mount
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
