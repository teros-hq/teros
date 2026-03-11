#!/bin/sh
set -e

# Install MCA dependencies if missing
for mca_dir in /app/mcas/*/; do
  if [ -f "${mca_dir}package.json" ] && [ ! -d "${mca_dir}node_modules" ]; then
    echo "Installing dependencies for ${mca_dir}..."
    cd "${mca_dir}"
    yarn install --frozen-lockfile 2>/dev/null || yarn install
    cd /app/packages/backend
  fi
done

exec "$@"
