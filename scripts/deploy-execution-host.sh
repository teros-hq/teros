#!/bin/bash
set -e

# Teros Execution-Host Deploy Script
# Runs ON the execution host (int5) — the machine that runs MCA containers for
# prod while the core lives in LXC 100. Updates the source checkout (containers
# bind-mount mcas/* from here), regenerates the union dependency manifests,
# rebuilds the runtime images and optionally recycles running containers.
#
# Orchestrated by deploy-server.sh over ssh (in parallel with the core deploy),
# but idempotent and safe to run standalone.
#
# Usage:
#   ./deploy-execution-host.sh [--recycle] [--secrets-stdin] [branch]
#
# Flags:
#   --recycle        Stop all running mca-* containers after the update so the
#                    next tool call spawns them with fresh source/images.
#                    Recycled containers respawn transparently: the core's
#                    stale-map self-heal retries the in-flight call.
#   --secrets-stdin  Read KEY=VALUE lines from stdin into the environment.
#                    Used by the orchestrator to pass WAHA_DOCKER_* creds
#                    without exposing them on the remote command line (ps).
#
# Environment:
#   WAHA_DOCKER_USERNAME / WAHA_DOCKER_PASSWORD
#                    Docker Hub creds for the paid WAHA base image. If absent,
#                    the whatsapp image build is skipped and the existing
#                    image is kept.

APP_PATH="/opt/teros"
GIT_BRANCH="main"
RECYCLE=false
SECRETS_STDIN=false

for arg in "$@"; do
    case "$arg" in
        --recycle) RECYCLE=true ;;
        --secrets-stdin) SECRETS_STDIN=true ;;
        *) GIT_BRANCH="$arg" ;;
    esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

if $SECRETS_STDIN; then
    while IFS= read -r line; do
        case "$line" in
            ''|'#'*) ;;
            *=*) export "$line" ;;
        esac
    done
fi

cd "$APP_PATH"

# The repo, docker and the pm2 daemon all belong to the service user — running
# as anyone else half-works (git dubious ownership, wrong pm2 daemon).
REPO_OWNER=$(stat -c %U .git)
if [ "$(id -un)" != "$REPO_OWNER" ]; then
    log_error "Run as '$REPO_OWNER' (repo owner), not '$(id -un)'"
    exit 1
fi

# === RECORD ROLLBACK POINT ===
OLD_SHA=$(git rev-parse HEAD)
echo "$OLD_SHA" > "$APP_PATH/.last-good-sha"
log_info "Rollback point recorded: $OLD_SHA"

# === GIT PULL ===
log_step "Pulling latest code from $GIT_BRANCH..."
git pull origin "$GIT_BRANCH"
NEW_SHA=$(git rev-parse HEAD)

# === GENERATE MCA DEPENDENCY UNION MANIFESTS ===
log_step "Generating MCA union dependency manifests..."
node scripts/gen-mca-union-deps.mjs

# === BUILD RUNTIME IMAGES ===
log_step "Building MCA runtime Docker image..."
docker build -t teros/mca-runtime:latest -f docker/mca-runtime/Dockerfile .
log_info "MCA runtime image built successfully"

log_step "Building Playwright MCA runtime Docker image..."
docker build -t teros/mca-runtime-playwright:latest -f docker/mca-runtime-playwright/Dockerfile .
log_info "Playwright MCA runtime image built successfully"

log_step "Building Bash MCA runtime Docker image..."
docker build -t teros/mca-runtime-bash:latest -f docker/mca-runtime-bash/Dockerfile .
log_info "Bash MCA runtime image built successfully"

if [ -n "$WAHA_DOCKER_USERNAME" ] && [ -n "$WAHA_DOCKER_PASSWORD" ]; then
    log_step "Building WhatsApp MCA runtime Docker image..."
    echo "$WAHA_DOCKER_PASSWORD" | docker login -u "$WAHA_DOCKER_USERNAME" --password-stdin
    docker build -t teros/mca-runtime-whatsapp:latest -f docker/mca-runtime-whatsapp/Dockerfile .
    docker logout
    log_info "WhatsApp MCA runtime image built successfully"
else
    log_warn "WAHA_DOCKER_USERNAME/PASSWORD not set — keeping existing whatsapp image"
fi

# === EGRESS FIREWALL ===
# Keep the live rules in sync with the committed source of truth. Idempotent;
# needs root (DOCKER-USER chain).
log_step "Applying egress firewall (network-layer SSRF isolation)..."
if [ "$(id -u)" -eq 0 ]; then
    "$APP_PATH/scripts/setup-egress-firewall.sh" || log_warn "Egress firewall failed to apply — check iptables/DOCKER-USER"
elif sudo -n true 2>/dev/null; then
    sudo "$APP_PATH/scripts/setup-egress-firewall.sh" || log_warn "Egress firewall failed to apply — check iptables/DOCKER-USER"
else
    log_warn "Egress firewall NOT applied (needs root). Enforce manually: sudo ./scripts/setup-egress-firewall.sh"
fi

# === CONDITIONAL AGENT REFRESH ===
# The container agent runs via tsx straight from packages/backend/src, but its
# workspace imports (@teros/shared, @teros/core, @teros/mca-sdk) resolve to
# each package's dist — so those need a rebuild when their sources change.
# Restart the agent only when something it executes actually changed; otherwise
# leave it (and its in-memory container map) alone.
if [ "$OLD_SHA" != "$NEW_SHA" ] && \
   git diff --name-only "$OLD_SHA" "$NEW_SHA" -- \
       yarn.lock package.json packages/shared packages/core packages/mca-sdk packages/backend \
   | grep -q .; then
    log_step "Agent-relevant sources changed — rebuilding workspace deps and restarting agent..."
    yarn install --frozen-lockfile
    yarn --cwd packages/shared build
    yarn --cwd packages/core build
    yarn --cwd packages/mca-sdk build
    pm2 restart teros-container-agent --update-env
else
    log_info "No agent-relevant changes ($OLD_SHA..$NEW_SHA) — agent keeps running"
fi

# === RECYCLE MCA CONTAINERS ===
if $RECYCLE; then
    log_step "Recycling running MCA containers..."
    RUNNING=$(docker ps --format '{{.Names}}' | grep '^mca-' || true)
    if [ -n "$RUNNING" ]; then
        # shellcheck disable=SC2086
        docker stop -t 5 $RUNNING
        log_info "Stopped: $(echo $RUNNING | tr '\n' ' ')"
    else
        log_info "No MCA containers running — nothing to recycle"
    fi
fi

# === AGENT HEALTH ===
# Poll the interface the agent actually binds to (CONTAINER_AGENT_HOST) — on
# the execution host it listens on the private tunnel IP so the core can reach
# it, NOT on loopback.
AGENT_PORT=$(grep -E '^CONTAINER_AGENT_PORT=' "$APP_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
AGENT_PORT="${AGENT_PORT:-10011}"
AGENT_HOST=$(grep -E '^CONTAINER_AGENT_HOST=' "$APP_PATH/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
AGENT_HOST="${AGENT_HOST:-127.0.0.1}"
log_step "Polling container agent health ($AGENT_HOST:$AGENT_PORT/health)..."
for i in $(seq 1 15); do
    if curl -sf "http://$AGENT_HOST:$AGENT_PORT/health" > /dev/null; then
        log_info "✅ Container agent is healthy"
        log_info "Execution host updated: $OLD_SHA -> $NEW_SHA"
        exit 0
    fi
    sleep 2
done

log_error "❌ Container agent did not answer /health after 30s"
log_error "   Diagnose: pm2 logs teros-container-agent ; curl -v http://$AGENT_HOST:$AGENT_PORT/health"
exit 1
