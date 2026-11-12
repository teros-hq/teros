#!/bin/bash
# Persistence bootstrap shared by every process that boots this image: the
# bash MCA (entrypoint.sh) and the workspace terminal host (term-host.sh).
#
# The container filesystem is ephemeral (recycled on idle); everything that
# must survive lives under the bind-mounted /app-data + /workspace.
set -e

# ── 1. Bootstrap persistent dirs (the mount may be brand new) ─────────────────
mkdir -p \
  /app-data/home \
  /app-data/.state \
  /app-data/bin \
  /app-data/.npm-global \
  /app-data/.python-user \
  /app-data/.cache/apt/archives/partial

# ── 1b. SSH state on the persistent home ──────────────────────────────────────
# OpenSSH resolves `~/.ssh` through /etc/passwd (root → /root), never $HOME, so
# known_hosts, keys and config written there vanished with the container.
# /root/.ssh is a link to the persistent /app-data/home/.ssh (0700, the
# permission ssh insists on). Existing files are carried over once.
mkdir -p /app-data/home/.ssh
chmod 700 /app-data/home/.ssh || true
if [ ! -L /root/.ssh ]; then
  if [ -d /root/.ssh ]; then
    cp -an /root/.ssh/. /app-data/home/.ssh/ 2>/dev/null || true
    rm -rf /root/.ssh
  fi
  ln -s /app-data/home/.ssh /root/.ssh
fi
# ── 2. Point APT's archive cache at the persistent volume and keep the .debs ──
# so a replay after a recycle is fast and mostly offline. docker-clean was
# removed from the image so debs are not auto-purged.
cat > /etc/apt/apt.conf.d/99teros-persist <<'CONF'
Dir::Cache::archives "/app-data/.cache/apt/archives";
APT::Keep-Downloaded-Packages "true";
CONF

# ── 3. Replay previously-installed apt packages, IN BACKGROUND ────────────────
# Never block startup: the backend health-gate is ~30s and a large package
# list can exceed it. Installs come mostly from the hash-verified cached .debs.
if [ -s /app-data/.state/apt-packages.txt ]; then
  (
    apt-get update -qq || true
    # Try the whole list at once (fast path); if that fails, install one by one
    # so a single unavailable package can't abort the rest.
    if ! xargs -r -a /app-data/.state/apt-packages.txt \
           apt-get install -y -qq --no-install-recommends -o DPkg::Lock::Timeout=600; then
      while read -r pkg; do
        [ -n "$pkg" ] || continue
        apt-get install -y -qq --no-install-recommends -o DPkg::Lock::Timeout=600 "$pkg" || true
      done < /app-data/.state/apt-packages.txt
    fi
    apt-get autoclean -qq || true
    echo "[apt-replay] done"
  ) >> /app-data/.state/apt-replay.log 2>&1 &
fi
