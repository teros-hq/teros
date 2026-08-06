#!/bin/bash
#
# Egress firewall for the `teros_egress` Docker network (TER-564, M3).
#
# The egress MCAs (mca.teros.http / mca.netlify / mca.make) must reach arbitrary
# PUBLIC hosts, but must NOT reach the cloud-metadata endpoint or any internal
# RFC1918 service — closing the DNS-rebinding TOCTOU at the NETWORK layer (the
# app-level SSRF guard cannot, since pinning the validated IP needs a custom fetch
# transport incompatible with the global `fetch` the MCAs mock in tests).
#
# It installs rules in iptables' DOCKER-USER chain (evaluated before Docker's own
# rules) scoped to the egress subnet only. Idempotent: tagged rules are removed and
# re-added on every run, so it is safe to call on each deploy.
#
# The subnet is NOT hardcoded: we ensure the network exists (preferring the fixed
# subnet, falling back to a Docker-assigned one if it clashes — "Pool overlaps")
# and read its LIVE subnet/gateway via `docker network inspect`. So the rules apply
# whatever subnet teros_egress ended up with, in sync with the backend's resilient
# create (docker-container-backend.ts:ensureEgressNetwork).
#
# LINUX/PROD ONLY. On macOS (Docker Desktop runs in a VM) host iptables do not apply
# to container traffic — there the network separation (teros_egress has no
# Mongo/Qdrant) is the active control; metadata blocking is a no-op locally (a dev
# Mac has no 169.254.169.254 metadata service anyway).
#
# Usage:  sudo ./scripts/setup-egress-firewall.sh
set -euo pipefail

NETWORK="teros_egress"
# Preferred subnet; must match TEROS_EGRESS_SUBNET in mca-network-policy.ts. Used
# only as the first attempt when creating the network — the rules below key off the
# network's LIVE subnet, so a fallback subnet is filtered just the same.
PREFERRED_SUBNET="172.31.255.0/24"
CHAIN="DOCKER-USER"
TAG="teros-egress-fw"

# Core callback host: where egress MCAs phone home (getUserSecrets, events, WS).
# On a SINGLE host this is the local gateway (already covered by the gateway
# ACCEPT below). On a SEPARATE execution host the core is reached over the
# private network (e.g. WireGuard 10.99.0.3) — an RFC1918 address that the DROP
# rules below would otherwise blackhole, breaking every egress MCA's callback.
# Read from MCA_CALLBACK_HOST (the agent's .env) or CORE_CALLBACK_HOST; empty on
# a single host, where no extra rule is needed. Port defaults to 10001.
CALLBACK_HOST="${MCA_CALLBACK_HOST:-${CORE_CALLBACK_HOST:-}}"
CALLBACK_PORT="${MCA_CALLBACK_PORT:-${BACKEND_PORT:-10001}}"
if [[ -z "$CALLBACK_HOST" && -f /opt/teros/.env ]]; then
  CALLBACK_HOST="$(grep -E '^MCA_CALLBACK_HOST=' /opt/teros/.env 2>/dev/null | head -1 | cut -d= -f2- || true)"
  CALLBACK_HOST="${CALLBACK_HOST//\"/}"   # strip double quotes if present
  CALLBACK_HOST="${CALLBACK_HOST//\'/}"   # strip single quotes if present
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[teros-egress-fw] not Linux — skipping (host iptables don't filter container traffic here)."
  exit 0
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "[teros-egress-fw] ERROR: iptables not found." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[teros-egress-fw] ERROR: docker not found." >&2
  exit 1
fi

# DOCKER-USER exists only once Docker has created its chains. Fail loud if missing
# (don't silently leave the egress subnet unfiltered).
if ! iptables -L "$CHAIN" >/dev/null 2>&1; then
  echo "[teros-egress-fw] ERROR: chain $CHAIN not found — is Docker running?" >&2
  exit 1
fi

# Ensure the egress network exists, then read its LIVE subnet/gateway. The backend
# also creates it on the first egress-MCA spawn; creating it here (idempotent) lets
# the firewall be applied at deploy time, before any MCA runs. Prefer the fixed
# subnet; fall back to a Docker-assigned one if it clashes (Pool overlaps).
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$PREFERRED_SUBNET" "$NETWORK" >/dev/null 2>&1 \
    || docker network create --driver bridge "$NETWORK" >/dev/null 2>&1 \
    || { echo "[teros-egress-fw] ERROR: could not create network $NETWORK." >&2; exit 1; }
fi

SUBNET="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)"
GATEWAY="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
if [[ -z "$SUBNET" ]]; then
  echo "[teros-egress-fw] ERROR: could not read subnet of $NETWORK." >&2
  exit 1
fi
# inspect usually returns the Gateway; derive .1 of the subnet as a fallback.
if [[ -z "$GATEWAY" ]]; then
  base="${SUBNET%/*}"      # strip /mask → 172.31.255.0
  GATEWAY="${base%.*}.1"   # last octet → .1 → 172.31.255.1
fi

# 1) Remove any prior teros-egress rules (idempotent re-apply). Line numbers shift
#    after each delete, so re-query from the top until none with our tag remain.
removed=0
while iptables -L "$CHAIN" --line-numbers -n | awk -v t="$TAG" '$0 ~ t {found=1} END{exit !found}'; do
  n=$(iptables -L "$CHAIN" --line-numbers -n | awk -v t="$TAG" '$0 ~ t {print $1; exit}')
  iptables -D "$CHAIN" "$n"
  removed=$((removed + 1))
done
[[ "$removed" -gt 0 ]] && echo "[teros-egress-fw] removed $removed stale rule(s)."

# 2) Insert rules. `-I` inserts at the TOP, so insert in REVERSE priority order:
#    the LAST inserted is evaluated FIRST. Final evaluation order (top→bottom):
#      a) ACCEPT ESTABLISHED,RELATED            (replies to inbound connections)
#      b) ACCEPT callback to the remote core   (only when on a separate exec host)
#      c) ACCEPT callback to the host gateway   (backend getUserSecrets callback)
#      d) ACCEPT DNS (53/udp + 53/tcp)          (resolution must keep working)
#      e) DROP   cloud metadata 169.254.0.0/16  (highest-value SSRF target)
#      f) DROP   RFC1918 10/8, 172.16/12, 192.168/16  (internal LAN / other containers)
#      g) (no rule) → internet egress passes via DOCKER-USER's default RETURN
for net in 192.168.0.0/16 172.16.0.0/12 10.0.0.0/8; do
  iptables -I "$CHAIN" -s "$SUBNET" -d "$net" -m comment --comment "$TAG" -j DROP
done
iptables -I "$CHAIN" -s "$SUBNET" -d 169.254.0.0/16 -m comment --comment "$TAG" -j DROP
iptables -I "$CHAIN" -s "$SUBNET" -p tcp --dport 53 -m comment --comment "$TAG" -j ACCEPT
iptables -I "$CHAIN" -s "$SUBNET" -p udp --dport 53 -m comment --comment "$TAG" -j ACCEPT
iptables -I "$CHAIN" -s "$SUBNET" -d "$GATEWAY" -m comment --comment "$TAG" -j ACCEPT

# Remote core callback (separate execution host): a narrow ACCEPT to the core's
# private IP + port ONLY — inserted last so it is evaluated FIRST, ahead of the
# RFC1918 DROP that would otherwise blackhole it. Scoped to the single host:port,
# so the SSRF protection (no Mongo/Qdrant/metadata/other containers) is intact.
# Skipped on a single host (CALLBACK_HOST empty → gateway rule already covers it).
if [[ -n "$CALLBACK_HOST" ]]; then
  iptables -I "$CHAIN" -s "$SUBNET" -d "$CALLBACK_HOST" -p tcp --dport "$CALLBACK_PORT" -m comment --comment "$TAG" -j ACCEPT
  echo "[teros-egress-fw] applied for $SUBNET: ACCEPT core $CALLBACK_HOST:$CALLBACK_PORT + gateway $GATEWAY + DNS + internet; DROP metadata + RFC1918."
else
  echo "[teros-egress-fw] applied for $SUBNET: ACCEPT gateway $GATEWAY + DNS + internet; DROP metadata + RFC1918."
fi

# Replies to connections INITIATED from outside the subnet (the core fetching the
# container's published port: listTools, tool execution). The DROP rules above are
# stateless, so without this the container's SYN-ACK back to the core's ephemeral
# port (an RFC1918 address on a multi-host setup) is blackholed and every egress
# MCA spawn dies with CONNECTION_FAILED. ESTABLISHED,RELATED only — a NEW
# connection from the container to an RFC1918 target still hits the DROPs, so the
# SSRF containment is unchanged. Inserted last → evaluated first.
iptables -I "$CHAIN" -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG" -j ACCEPT

# 3) Persist across reboots: via netfilter-persistent where installed, or via
#    the teros-egress-firewall systemd oneshot (infra repo: ansible playbook
#    setup-egress-firewall-persistence.yml) which re-runs this script after
#    Docker at boot. Without either, a reboot drops the WHOLE egress firewall
#    (SSRF protection included) until the next deploy. Best-effort: absence is
#    a warning, not a failure.
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null 2>&1 && echo "[teros-egress-fw] rules persisted (netfilter-persistent)." \
    || echo "[teros-egress-fw] WARN: netfilter-persistent save failed — rules are live but won't survive a reboot."
elif systemctl is-enabled teros-egress-firewall.service >/dev/null 2>&1; then
  echo "[teros-egress-fw] persistence handled by the teros-egress-firewall systemd unit (re-applies at boot)."
else
  echo "[teros-egress-fw] WARN: no persistence — rules are LIVE but will NOT survive a reboot. Install iptables-persistent or enable the teros-egress-firewall systemd unit."
fi
