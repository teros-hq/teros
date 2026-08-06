#!/bin/bash
set -e

# Teros Server-Side Deploy Script
# This script runs ON the production server after git pull
# It handles builds, secrets, and service restarts
#
# Usage:
#   ./deploy-server.sh              # Deploy main branch with prod env
#   ./deploy-server.sh staging      # Deploy staging branch with prod env
#   DEPLOY_ENV=staging ./deploy-server.sh staging  # Deploy staging branch with staging env
#
# Environment variables:
#   DEPLOY_BRANCH - Git branch to deploy (default: main)
#   DEPLOY_ENV    - Infisical environment (default: prod)

# === LOAD ENVIRONMENT ===
# Load Infisical credentials from .env.deploy if not already set
if [ -z "$INFISICAL_CLIENT_ID" ] && [ -f /opt/teros/.env.deploy ]; then
    set -a
    source /opt/teros/.env.deploy
    set +a
fi

# === CONFIGURATION ===
APP_PATH="/opt/teros"
# Set INFISICAL_PROJECT_ID in the server's .env.deploy (do not hardcode the real
# project id here — it ships with the repo).
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:?INFISICAL_PROJECT_ID must be set (server .env.deploy)}"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-https://eu.infisical.com}"

# Git branch to deploy (can be overridden via env var or argument)
GIT_BRANCH="${DEPLOY_BRANCH:-${1:-main}}"

# Infisical environment (can be overridden via env var)
INFISICAL_ENV="${DEPLOY_ENV:-prod}"

# Execution host ssh target (user@host) — the machine that runs MCA containers.
# Supplied via the environment (.env.deploy on the server); infra details do not
# live in this repo. When empty, the execution-host update is skipped.
EXECUTION_HOST_SSH="${EXECUTION_HOST_SSH:-}"

# Discord webhook for deploy announcements (start / success / failure).
# Supplied via .env.deploy on the server; when empty, notifications are skipped.
DISCORD_DEPLOY_WEBHOOK_URL="${DISCORD_DEPLOY_WEBHOOK_URL:-}"

# === COLORS ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# === DISCORD NOTIFICATIONS ===
# Notifications must never break (or slow down) the deploy: payloads are
# JSON-encoded with node (handles quotes/newlines in commit subjects), capped
# to Discord's 2000-char content limit, and curl failures are swallowed.
notify_discord() {
    [ -n "$DISCORD_DEPLOY_WEBHOOK_URL" ] || return 0
    local payload
    # flags: 4 = SUPPRESS_EMBEDS — commit links must not spawn preview cards
    payload=$(node -e 'console.log(JSON.stringify({content: process.argv[1].slice(0, 2000), flags: 4}))' "$1" 2>/dev/null) || return 0
    curl -sf -m 10 -X POST -H 'Content-Type: application/json' \
        -d "$payload" "$DISCORD_DEPLOY_WEBHOOK_URL" > /dev/null 2>&1 || \
        log_warn "Discord notification failed (deploy continues)"
}

# Announce failures too — a channel that says "started" and never resolves is
# worse than no channel. EXIT trap (not ERR) so it also covers the explicit
# `exit 1` paths, not just set -e aborts; on a clean exit it stays silent.
notify_discord_on_failure() {
    local code=$?
    if [ "$code" -ne 0 ]; then
        notify_discord "❌ **Deploy FAILED** (branch \`$GIT_BRANCH\`, exit $code). The core keeps running the previous build if the restart was not reached. Manual rollback: \`./scripts/rollback.sh\` on the server.${GITHUB_RUN_URL:+ · [CI run]($GITHUB_RUN_URL)}"
    fi
}

# === CHANGE TO APP DIRECTORY ===
cd "$APP_PATH"

# === RECORD ROLLBACK POINT ===
# El SHA que corre AHORA (antes del pull) es la última versión sana conocida. Lo
# persistimos para que `./scripts/rollback.sh` pueda deshacer este deploy con un
# solo comando, y lo guardamos en memoria para el auto-rollback de más abajo si
# el health-polling no pasa.
PREVIOUS_SHA=$(git rev-parse HEAD)
echo "$PREVIOUS_SHA" > "$APP_PATH/.last-good-sha"
log_info "Rollback point recorded: $PREVIOUS_SHA"

# GitHub web URL for commit links in Discord messages (ssh remote → https)
REPO_URL=$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')

# GitHub Actions run URL, passed by the deploy workflow; empty on manual runs.
GITHUB_RUN_URL="${GITHUB_RUN_URL:-}"

# Resolve the target SHA up front so the start message can link the full diff
# (compare view with the incoming commit list) instead of a single commit.
# Redundant with the pull below, but cheap.
git fetch -q origin "$GIT_BRANCH"
TARGET_SHA=$(git rev-parse "origin/$GIT_BRANCH")

START_MSG="🚀 **Deploy started** — branch \`$GIT_BRANCH\` on \`$(hostname)\`"
if [ "$TARGET_SHA" = "$PREVIOUS_SHA" ]; then
    START_MSG="$START_MSG, redeploying [\`${PREVIOUS_SHA:0:8}\`]($REPO_URL/commit/$PREVIOUS_SHA)"
else
    START_MSG="$START_MSG, [\`${PREVIOUS_SHA:0:8}\` → \`${TARGET_SHA:0:8}\`]($REPO_URL/compare/$PREVIOUS_SHA...$TARGET_SHA)"
fi
if [ -n "$GITHUB_RUN_URL" ]; then
    START_MSG="$START_MSG · [CI run]($GITHUB_RUN_URL)"
fi
notify_discord "$START_MSG"
trap notify_discord_on_failure EXIT

# === GIT PULL ===
log_step "Pulling latest code from $GIT_BRANCH..."
git pull origin "$GIT_BRANCH"
NEW_SHA=$(git rev-parse HEAD)

# === GENERATE MCA DEPENDENCY UNION MANIFESTS ===
log_step "Generating MCA union dependency manifests..."
node scripts/gen-mca-union-deps.mjs

# NOTE: MCA runtime images (mca-runtime, playwright, whatsapp) are NOT built
# here anymore — no MCA containers run on this host since the two-machine
# cutover. They are built on the execution host by deploy-execution-host.sh,
# launched in parallel below (saves ~5 min of deploy wall-clock).

# === ENSURE DOCKER SERVICES ARE RUNNING ===
log_step "Ensuring Docker services (MongoDB, Qdrant) are running..."
docker compose up -d mongodb qdrant
log_info "Docker services started"

# === EGRESS FIREWALL (TER-564 M3) ===
# Constrain the teros_egress subnet at the network layer: ACCEPT internet + the
# backend-callback gateway + DNS, DROP cloud metadata (169.254/16) + RFC1918. Rules
# are keyed by subnet, so they're valid even before the backend creates the egress
# network on the first egress-MCA spawn. Idempotent; needs root (DOCKER-USER chain).
log_step "Applying egress firewall (network-layer SSRF isolation)..."
if [ "$(id -u)" -eq 0 ]; then
    "$APP_PATH/scripts/setup-egress-firewall.sh" || log_warn "Egress firewall failed to apply — check iptables/DOCKER-USER"
elif sudo -n true 2>/dev/null; then
    sudo "$APP_PATH/scripts/setup-egress-firewall.sh" || log_warn "Egress firewall failed to apply — check iptables/DOCKER-USER"
else
    log_warn "Egress firewall NOT applied (needs root). Enforce manually: sudo ./scripts/setup-egress-firewall.sh"
fi

# === EXPORT SECRETS FROM INFISICAL ===
# Runs early (before the package builds) so the execution-host update below can
# be launched as soon as possible — it needs the WAHA creds from the fresh .env.
log_step "Exporting secrets from Infisical..."

# Check if credentials are available
if [ -z "$INFISICAL_CLIENT_ID" ] || [ -z "$INFISICAL_CLIENT_SECRET" ]; then
    log_error "INFISICAL_CLIENT_ID or INFISICAL_CLIENT_SECRET not set"
    log_error "Make sure they are exported in ~/.bashrc"
    exit 1
fi

# Login and get token
log_info "Authenticating with Infisical..."
INFISICAL_TOKEN=$(infisical login \
    --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --domain="$INFISICAL_DOMAIN" \
    --plain \
    --silent 2>&1)

if [ -z "$INFISICAL_TOKEN" ]; then
    log_error "Failed to authenticate with Infisical"
    exit 1
fi

# Export secrets
log_info "Fetching secrets from Infisical..."
SECRETS=$(infisical export \
    --env=$INFISICAL_ENV \
    --path=/ \
    --projectId="$INFISICAL_PROJECT_ID" \
    --domain="$INFISICAL_DOMAIN" \
    --token="$INFISICAL_TOKEN" \
    --format=dotenv \
    --silent 2>&1)

# Write to .env
echo "$SECRETS" > "$APP_PATH/.env"

# Add production-specific overrides
cat >> "$APP_PATH/.env" << 'ENVEOF'

# Production overrides
NODE_ENV=production
PORT=10001
INFISICAL_DOMAIN=https://eu.infisical.com
ENVEOF

log_info "Secrets exported to .env"

# === UPDATE EXECUTION HOST (IN PARALLEL) ===
# The execution host runs the MCA containers: it needs the same commit checked
# out (containers bind-mount mcas/* from its disk) and the runtime images
# rebuilt there. Launched in the background so it overlaps with the package and
# frontend builds below; awaited right before the backend restart.
EXEC_HOST_PID=""
if [ -n "$EXECUTION_HOST_SSH" ]; then
    log_step "Launching execution-host update on $EXECUTION_HOST_SSH (background)..."
    EXEC_HOST_LOG=$(mktemp /tmp/deploy-exec-host.XXXXXX.log)
    # WAHA creds travel via stdin, not the remote argv (visible in ps there)
    WAHA_USER=$(bash -c 'set -a; source "$1" >/dev/null 2>&1; printf %s "$WAHA_DOCKER_USERNAME"' _ "$APP_PATH/.env")
    WAHA_PASS=$(bash -c 'set -a; source "$1" >/dev/null 2>&1; printf %s "$WAHA_DOCKER_PASSWORD"' _ "$APP_PATH/.env")
    # Execute the script version shipped in the TARGET branch (fetched, not the
    # possibly-stale checkout on the execution host) — avoids the bootstrap
    # problem where the host doesn't have (or has an old) deploy-execution-host.sh
    # until it pulls, which is precisely this script's job.
    printf 'WAHA_DOCKER_USERNAME=%s\nWAHA_DOCKER_PASSWORD=%s\n' "$WAHA_USER" "$WAHA_PASS" | \
        ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 \
            "$EXECUTION_HOST_SSH" \
            "git -C /opt/teros fetch -q origin $GIT_BRANCH && git -C /opt/teros show origin/$GIT_BRANCH:scripts/deploy-execution-host.sh > /tmp/deploy-execution-host.sh && bash /tmp/deploy-execution-host.sh --recycle --secrets-stdin $GIT_BRANCH" \
            > "$EXEC_HOST_LOG" 2>&1 &
    EXEC_HOST_PID=$!
else
    log_warn "EXECUTION_HOST_SSH not set — skipping execution-host update (runtime images are NOT rebuilt anywhere)"
fi

# === INSTALL DEPENDENCIES ===
log_step "Installing dependencies..."
yarn install --frozen-lockfile

# === BUILD PACKAGES ===
log_step "Building packages..."

log_info "Building @teros/shared..."
yarn --cwd packages/shared build

log_info "Building @teros/core..."
yarn --cwd packages/core build

log_info "Building @teros/mca-sdk..."
yarn --cwd packages/mca-sdk build

log_info "Building @teros/backend..."
yarn --cwd packages/backend build

# === BUILD FRONTEND ===
log_step "Building frontend..."
infisical run \
    --env=$INFISICAL_ENV \
    --projectId="$INFISICAL_PROJECT_ID" \
    --domain="$INFISICAL_DOMAIN" \
    --token="$INFISICAL_TOKEN" \
    -- yarn --cwd packages/app build

# Verify frontend build
WS_URL=$(grep -o "wss://[^\"']*" packages/app/dist/_expo/static/js/web/entry-*.js 2>/dev/null | head -1 || echo "")
if [ -z "$WS_URL" ]; then
    log_warn "Could not verify WebSocket URL in bundle"
else
    log_info "Frontend built with WebSocket URL: $WS_URL"
    if [[ "$WS_URL" != *"be.teros.ai"* ]]; then
        log_error "WebSocket URL doesn't look like production!"
        log_error "Expected: wss://be.teros.ai/ws"
        log_error "Got: $WS_URL"
        exit 1
    fi
fi

# === DEPLOY FRONTEND ===
log_step "Deploying frontend to nginx..."
mkdir -p /var/www/teros
rm -rf /var/www/teros/*
cp -r packages/app/dist/* /var/www/teros/
log_info "Frontend deployed to /var/www/teros/"

# === SYNC DATABASE (MCAs, Models) ===
log_step "Syncing MCAs and models to database..."
infisical run \
    --env=$INFISICAL_ENV \
    --projectId="$INFISICAL_PROJECT_ID" \
    --domain="$INFISICAL_DOMAIN" \
    --token="$INFISICAL_TOKEN" \
    -- yarn workspace @teros/backend sync
log_info "Database sync complete"

# === WAIT FOR EXECUTION HOST UPDATE ===
# Must complete BEFORE the backend restart: if the execution host failed to
# update, we abort while the previous core build keeps running — no version
# skew is introduced between the two hosts.
if [ -n "$EXEC_HOST_PID" ]; then
    log_step "Waiting for execution-host update to finish..."
    if wait "$EXEC_HOST_PID"; then
        sed 's/^/[exec-host] /' "$EXEC_HOST_LOG"
        log_info "✅ Execution host updated"
    else
        sed 's/^/[exec-host] /' "$EXEC_HOST_LOG"
        log_error "❌ Execution-host update FAILED — aborting BEFORE the backend restart."
        log_error "   The core keeps running the previous build (no version skew)."
        log_error "   Diagnose on the execution host, then re-run: ./scripts/deploy-server.sh"
        exit 1
    fi
    rm -f "$EXEC_HOST_LOG"
fi

# === RESTART BACKEND ===
log_step "Restarting backend with PM2..."
pm2 restart teros-backend || pm2 start ecosystem.prod.config.cjs
pm2 save

# === VERIFICATION ===
log_step "Verifying deployment..."

# Check PM2 status
log_info "PM2 Status:"
pm2 list

# Backend health: sondea el /health profundo (TER-418) en lugar del antiguo
# `sleep 15` + single-curl, que daba falsos negativos cuando el backend (fork
# mode) tardaba unos segundos extra en cargar MCAs/conexiones tras el restart
# (incidente 2026-05-28). Si no levanta dentro del presupuesto (30 × 2s = 60s),
# el deploy FALLA y deja al operador el rollback con `./scripts/rollback.sh`.
# El rollback es MANUAL a propósito: sin un entorno de staging donde ensayarlo
# (TER-145), un auto-rollback destructivo (git reset + rebuild) es más arriesgado
# que el fallo que pretende arreglar — la industria lo desaconseja sin thresholding
# ni una prueba previa de que "un paso lleva a estado estable".
echo ""
log_info "Polling backend health (be.teros.ai/health)..."
if node scripts/wait-for-health.mjs "https://be.teros.ai/health" 30 2; then
    log_info "✅ Backend health check passed"
else
    log_error "❌ Backend did not become healthy after polling (60s)."
    log_error "   The new code is deployed but unhealthy. To roll back to the previous"
    log_error "   known-good version (recorded in .last-good-sha) run ON THE SERVER:"
    log_error "       cd $APP_PATH && ./scripts/rollback.sh"
    log_error "   Diagnose first: pm2 logs teros-backend ; curl -s https://be.teros.ai/health"
    exit 1
fi

# Check frontend
if curl -sf "https://os.teros.ai" > /dev/null; then
    log_info "✅ Frontend is responding"
else
    log_error "❌ Frontend is not responding"
    exit 1
fi

# === DISCORD SUCCESS SUMMARY ===
if [ "$PREVIOUS_SHA" = "$NEW_SHA" ]; then
    notify_discord "✅ **Deploy complete** — branch \`$GIT_BRANCH\`, no new commits (redeploy of [\`${NEW_SHA:0:8}\`]($REPO_URL/commit/$NEW_SHA))"
else
    COMMIT_COUNT=$(git rev-list --count "$PREVIOUS_SHA..$NEW_SHA")
    # Plain markdown lines (not a code block — links don't render there), each
    # SHA linked to its commit on GitHub. Capped at 10 lines: with links every
    # line costs ~150 chars against Discord's 2000-char message limit.
    COMMIT_LIST=$(git log --no-decorate --no-merges --format="[\`%h\`]($REPO_URL/commit/%H) %s" "$PREVIOUS_SHA..$NEW_SHA" | head -10)
    if [ "$COMMIT_COUNT" -gt 10 ]; then
        COMMIT_LIST="$COMMIT_LIST
… and $((COMMIT_COUNT - 10)) more commits"
    fi
    notify_discord "✅ **Deploy complete** — branch \`$GIT_BRANCH\`, [\`${PREVIOUS_SHA:0:8}\` → \`${NEW_SHA:0:8}\`]($REPO_URL/compare/$PREVIOUS_SHA...$NEW_SHA) ($COMMIT_COUNT commits)
$COMMIT_LIST"
fi

echo ""
log_info "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
log_info "${GREEN}║           DEPLOYMENT COMPLETE!                             ║${NC}"
log_info "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
log_info "${CYAN}URLs:${NC}"
echo "  Frontend: https://os.teros.ai"
echo "  Backend:  https://be.teros.ai"
echo ""
log_info "${CYAN}Useful commands:${NC}"
echo "  pm2 status              - View process status"
echo "  pm2 logs teros-backend  - View backend logs"
echo "  pm2 restart all         - Restart backend"
echo "  docker logs teros-mongodb - View MongoDB logs"
echo ""
