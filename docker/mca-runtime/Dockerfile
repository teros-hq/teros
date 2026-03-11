# MCA Runtime Container
# 
# Generic container for running any MCA. Mount the MCA directory at runtime.
#
# Build:
#   docker build -t teros/mca-runtime:latest -f docker/mca-runtime/Dockerfile .
#
# Run:
#   docker run -p 3000:3000 \
#     -v $(pwd)/mcas/mca.teros.bash:/app/mca \
#     -e MCA_ID=mca.teros.bash \
#     teros/mca-runtime:latest
#
# With secrets:
#   docker run -p 3000:3000 \
#     -v $(pwd)/mcas/mca.teros.gmail:/app/mca \
#     -e MCA_ID=mca.teros.gmail \
#     -e GOOGLE_CLIENT_ID=xxx \
#     -e GOOGLE_CLIENT_SECRET=xxx \
#     teros/mca-runtime:latest

FROM node:20-alpine

# Install common tools that MCAs might need
RUN apk add --no-cache \
    bash \
    curl \
    git \
    openssh-client \
    && rm -rf /var/cache/apk/*

# Install global tools
RUN npm install -g tsx typescript

WORKDIR /app

# ─────────────────────────────────────────────────────────────────
# Pre-install @teros/shared and @teros/mca-sdk dependencies.
#
# Strategy: bake only the node_modules (external deps) into the image.
# The actual source/dist is mounted at runtime from the host via:
#   -v /opt/teros/packages:/app/packages:ro
# The entrypoint then copies fresh dist+src on top of these pre-installed deps,
# so containers always run the latest code without needing a rebuild.
# ─────────────────────────────────────────────────────────────────

# Pre-install @teros/shared deps (zod, etc.)
COPY packages/shared/package.json /sdk-deps/shared/package.json
RUN cd /sdk-deps/shared && npm install --omit=dev 2>/dev/null || true

# Pre-install @teros/mca-sdk deps (@modelcontextprotocol/sdk, etc.)
COPY packages/mca-sdk/package.json /sdk-deps/mca-sdk/package.json
RUN cd /sdk-deps/mca-sdk && \
    node -e " \
      const p=require('./package.json'); \
      if(p.dependencies) delete p.dependencies['@teros/shared']; \
      require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)) \
    " && \
    npm install --omit=dev 2>/dev/null || true && \
    mkdir -p node_modules/@teros && \
    ln -sf /sdk-deps/shared node_modules/@teros/shared

# ─────────────────────────────────────────────────────────────────
# MCA Directory (mounted at runtime)
# ─────────────────────────────────────────────────────────────────
RUN mkdir -p /app/mca

# Copy entrypoint script
COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Health check (using curl with IPv4 to avoid IPv6 connection issues)
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
