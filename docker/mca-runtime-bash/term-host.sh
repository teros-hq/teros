#!/bin/bash
# Workspace terminal host entrypoint (teros-term-* containers).
#
# Same image and mounts as the bash MCA, but no MCA server: the backend starts
# a tmux server in here (`docker exec … tmux -L teros`) and attaches to it in
# control mode. This process only bootstraps persistence and keeps the
# container alive; tini (`docker run --init`) reaps tmux's orphans.
set -e

/usr/local/lib/teros/persist-bootstrap.sh

exec sleep infinity
