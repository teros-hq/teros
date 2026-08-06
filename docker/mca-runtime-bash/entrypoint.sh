#!/bin/bash
# Bash MCA runtime entrypoint.
#
# Layers persistence bootstrap + apt replay on top of the base runtime
# entrypoint (which copies the MCA source and launches it via tsx). The
# container filesystem is ephemeral (recycled on idle); everything that must
# survive lives under the bind-mounted /app-data + /workspace.
set -e

# ── 1. Bootstrap persistent dirs (the mount may be brand new) ─────────────────
mkdir -p \
  /app-data/home \
  /app-data/.state \
  /app-data/bin \
  /app-data/.npm-global \
  /app-data/.python-user \
  /app-data/.cache/apt/archives/partial

# ── 2. Point APT's archive cache at the persistent volume and keep the .debs ──
# so a replay after a recycle is fast and mostly offline. docker-clean was
# removed from the image so debs are not auto-purged.
cat > /etc/apt/apt.conf.d/99teros-persist <<'EOF'
Dir::Cache::archives "/app-data/.cache/apt/archives";
APT::Keep-Downloaded-Packages "true";
EOF

# ── 3. Replay previously-installed apt packages, IN BACKGROUND ────────────────
# Never block MCA startup: the backend health-gate is ~30s and a large package
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

# ── 4. Hand off to the base runtime entrypoint ────────────────────────────────
exec /entrypoint-base.sh
