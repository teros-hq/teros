# MCA Runtime Container - Playwright Edition
# 
# Extended runtime with Playwright and Chromium pre-installed.
# Based on the standard MCA runtime but with browser support.
#
# Build:
#   docker build -t teros/mca-runtime-playwright:latest -f docker/mca-runtime-playwright/Dockerfile .
#
# Run:
#   docker run -p 3000:3000 \
#     -v $(pwd)/mcas/mca.teros.playwright:/app/mca \
#     -e MCA_ID=mca.teros.playwright \
#     teros/mca-runtime-playwright:latest

# Use Playwright's official image as base (includes browsers + deps)
FROM mcr.microsoft.com/playwright:v1.58.0-noble

# Install Node.js 20 (Playwright image uses Ubuntu)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install global tools
RUN npm install -g tsx typescript

WORKDIR /app

# ─────────────────────────────────────────────────────────────────
# Pre-install @teros/shared and @teros/mca-sdk dependencies.
# Same strategy as mca-runtime base: bake only node_modules into
# /sdk-deps so the entrypoint can find them at runtime.
# ─────────────────────────────────────────────────────────────────

# Pre-install @teros/shared deps (zod, etc.)
COPY packages/shared/package.json /sdk-deps/shared/package.json
RUN cd /sdk-deps/shared && npm install --omit=dev 2>/dev/null || true

# Pre-install @teros/mca-sdk deps
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

# Copy entrypoint script (same as base runtime)
COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment defaults
ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production

# Playwright-specific: skip browser download at npm install (already included)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
