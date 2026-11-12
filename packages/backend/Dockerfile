# Backend image (also used by the container-agent service with another CMD).
#
# Size discipline: this image is published for every release, so it only
# carries what the backend needs at runtime. The frontend, e2e and MCA
# workspaces are NOT part of the install (their dependencies used to be hoisted
# in here: ~1 GB of Expo, Tamagui, React Native and per-MCA node_modules). MCA
# code runs in the mca-runtime images, which bring their own dependencies; the
# backend only reads the MCAs' manifests, tool definitions and static files.

# Stage 1: Build
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Install build tools required for native modules (node-pty, bcrypt, sharp)
RUN apk add --no-cache python3 make g++

# Copy workspace root files
COPY package.json yarn.lock ./

# Only the workspaces the backend is built from. @teros/testing is a backend
# devDependency, so its manifest must exist for the install to resolve.
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mca-sdk/package.json ./packages/mca-sdk/
COPY packages/testing/package.json ./packages/testing/
COPY packages/workflows/package.json ./packages/workflows/

# --no-frozen-lockfile: the lockfile covers the whole monorepo (app, e2e, MCAs);
# with those workspaces absent yarn prunes their entries instead of failing.
RUN yarn install --no-frozen-lockfile --ignore-engines

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/backend ./packages/backend
COPY packages/mca-sdk ./packages/mca-sdk
COPY packages/testing ./packages/testing
COPY packages/workflows ./packages/workflows

# Build the TS packages in dependency order
WORKDIR /app/packages/shared
RUN yarn build
WORKDIR /app/packages/core
RUN yarn build
WORKDIR /app/packages/mca-sdk
RUN yarn build
WORKDIR /app/packages/workflows
RUN yarn build
WORKDIR /app/packages/backend
RUN yarn build

# Drop devDependencies (typescript, vitest, @types, …) now that dist/ exists.
# tsx itself is installed globally in the runtime stage.
WORKDIR /app
RUN yarn install --production --no-frozen-lockfile --ignore-engines && yarn cache clean

# MCAs: manifests, tool definitions, static assets and sources for the boot sync.
# They are not workspaces of this install, so no node_modules come with them.
COPY mcas ./mcas

# Stage 2: Production
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

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

# Copy workflows package (compiled + source for resolution)
COPY --from=builder /app/packages/workflows/dist ./packages/workflows/dist
COPY --from=builder /app/packages/workflows/src ./packages/workflows/src
COPY --from=builder /app/packages/workflows/package.json ./packages/workflows/

# Copy backend package (compiled + source for sync scripts)
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/src ./packages/backend/src
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/backend/static ./packages/backend/static

# Copy MCAs (needed for MCA boot sync and tool definitions)
COPY --from=builder /app/mcas ./mcas

# Fix workspace symlinks - remove old ones and create correct absolute symlinks
RUN rm -rf node_modules/@teros && \
    mkdir -p node_modules/@teros && \
    ln -s /app/packages/shared node_modules/@teros/shared && \
    ln -s /app/packages/core node_modules/@teros/core && \
    ln -s /app/packages/mca-sdk node_modules/@teros/mca-sdk && \
    ln -s /app/packages/workflows node_modules/@teros/workflows

# Set working directory to backend
WORKDIR /app/packages/backend

# Expose WebSocket port
EXPOSE 3000

# Health check (start_period gives time for sync scripts before first check)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start backend server
CMD ["yarn", "start"]
