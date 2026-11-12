#!/bin/bash
# Bash MCA runtime entrypoint.
#
# Layers persistence bootstrap + apt replay (persist-bootstrap.sh) on top of
# the base runtime entrypoint (which copies the MCA source and launches it via
# tsx).
set -e

/usr/local/lib/teros/persist-bootstrap.sh

# Hand off to the base runtime entrypoint.
exec /entrypoint-base.sh
