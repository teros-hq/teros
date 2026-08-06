#!/bin/bash
set -e

# Build the MCA runtime Docker images needed for a local `docker compose up`.
#
# The container-agent spawns MCA containers with `docker run` against images
# that must already exist on the Docker daemon — `docker compose up` does not
# build them (they are tagged images, not compose services). Run this once
# after cloning (and again whenever mcas/*/package.json or the runtime
# Dockerfiles change) before starting the stack.
#
# Mirrors the build steps of scripts/deploy-execution-host.sh (prod), minus
# the SSH/pm2/firewall orchestration that only applies to the execution host.
#
# Images built: mca-runtime (default), mca-runtime-playwright, mca-runtime-bash.
# mca-runtime-whatsapp is built only if WAHA_DOCKER_USERNAME/PASSWORD are set
# (paid upstream base image) — otherwise it is skipped with a warning.
# mca-runtime-docker-env is NOT built here; it is not wired into any deploy
# script yet and is out of scope for this ticket.
#
# Usage:
#   ./scripts/build-mca-runtimes.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> Generating MCA union dependency manifests..."
node scripts/gen-mca-union-deps.mjs

echo "==> Building mca-runtime image..."
docker build -t teros/mca-runtime:latest -f docker/mca-runtime/Dockerfile .

echo "==> Building mca-runtime-playwright image..."
docker build -t teros/mca-runtime-playwright:latest -f docker/mca-runtime-playwright/Dockerfile .

echo "==> Building mca-runtime-bash image..."
docker build -t teros/mca-runtime-bash:latest -f docker/mca-runtime-bash/Dockerfile .

if [ -n "$WAHA_DOCKER_USERNAME" ] && [ -n "$WAHA_DOCKER_PASSWORD" ]; then
  echo "==> Building mca-runtime-whatsapp image..."
  echo "$WAHA_DOCKER_PASSWORD" | docker login -u "$WAHA_DOCKER_USERNAME" --password-stdin
  docker build -t teros/mca-runtime-whatsapp:latest -f docker/mca-runtime-whatsapp/Dockerfile .
  docker logout
else
  echo "==> Skipping mca-runtime-whatsapp (set WAHA_DOCKER_USERNAME/WAHA_DOCKER_PASSWORD to build it)"
fi

echo "==> Done. Run 'docker compose up' to start the stack."
