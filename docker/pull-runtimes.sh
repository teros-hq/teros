#!/bin/sh
# Get the MCA runtime images the container-agent starts apps from.
#
# MCA manifests name their runtime as teros/mca-runtime[-bash|-playwright]:latest,
# and the container-agent runs them straight from the Docker daemon, so
# `docker compose pull` does not fetch them. This pulls the release builds
# from GHCR (same TEROS_IMAGE_TAG as the compose images) and tags them with
# those local names. If the pull fails (no network, unpublished tag), it
# builds them from this checkout with scripts/build-mca-runtimes.sh (slow).
set -eu
cd "$(dirname "$0")/.."

if [ -z "${TEROS_IMAGE_TAG:-}" ] && [ -f .env ]; then
  TEROS_IMAGE_TAG=$(sed -n 's/^TEROS_IMAGE_TAG=//p' .env | tail -n 1)
fi
TAG="${TEROS_IMAGE_TAG:-latest}"
REGISTRY="${TEROS_IMAGE_REGISTRY:-ghcr.io/teros-hq}"

for name in mca-runtime mca-runtime-bash mca-runtime-playwright; do
  echo "Pulling $name ($TAG)..."
  if ! docker pull --quiet "$REGISTRY/teros-$name:$TAG" >/dev/null; then
    echo "Could not pull $REGISTRY/teros-$name:$TAG; building the runtimes locally instead (slow)."
    exec ./scripts/build-mca-runtimes.sh
  fi
  docker tag "$REGISTRY/teros-$name:$TAG" "teros/$name:latest"
done

echo "MCA runtimes ready."
