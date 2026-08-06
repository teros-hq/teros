#!/bin/bash
set -euo pipefail

# Rollback de un comando (TER-519).
#
# Restaura la última versión sana conocida del backend y la reinicia. El "punto
# de rollback" lo persiste deploy-server.sh en .last-good-sha (el SHA que estaba
# corriendo ANTES del último deploy), de modo que `./scripts/rollback.sh` sin
# argumentos deshace el último deploy. También acepta un SHA explícito.
#
# Por qué git-reset y no `pm2 revert`: este setup despliega con `git pull` +
# `pm2 restart` (NO el sistema `pm2 deploy`), así que PM2 no guarda versiones
# anteriores del código — la fuente de verdad de "qué corría" es el SHA de git.
#
# Uso (en el server de prod, /opt/teros):
#   ./scripts/rollback.sh            # vuelve al SHA de .last-good-sha
#   ./scripts/rollback.sh <sha>      # vuelve a un SHA explícito
#
# Alcance: revierte el CÓDIGO del backend (git reset + rebuild de packages) y lo
# reinicia. El frontend estático ya servido por nginx NO se toca — rara vez es la
# causa de un crash-loop; para revertirlo, re-desplegar desde el SHA bueno.

APP_PATH="${APP_PATH:-/opt/teros}"
HEALTH_URL="${HEALTH_URL:-https://be.teros.ai/health}"
LAST_GOOD_FILE="$APP_PATH/.last-good-sha"

# === COLORS ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

cd "$APP_PATH"

# === RESOLVER SHA TARGET ===
TARGET_SHA="${1:-}"
if [ -z "$TARGET_SHA" ]; then
    if [ ! -f "$LAST_GOOD_FILE" ]; then
        log_error "No hay $LAST_GOOD_FILE y no se pasó un SHA. Nada a lo que volver."
        log_error "Uso: ./scripts/rollback.sh <sha>"
        exit 1
    fi
    TARGET_SHA=$(cat "$LAST_GOOD_FILE")
fi

# Resolver a SHA pleno y validar que existe en el repo.
if ! TARGET_SHA=$(git rev-parse --verify "${TARGET_SHA}^{commit}" 2>/dev/null); then
    log_error "SHA inválido o desconocido: ${1:-$(cat "$LAST_GOOD_FILE" 2>/dev/null)}"
    exit 1
fi

CURRENT_SHA=$(git rev-parse HEAD)
if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
    log_warn "HEAD ya está en $TARGET_SHA — no hay nada que revertir (se reiniciará igualmente)."
else
    log_warn "Rollback: $CURRENT_SHA → $TARGET_SHA"
fi

# === REVERTIR CÓDIGO ===
log_step "Reseteando el working tree a $TARGET_SHA..."
git reset --hard "$TARGET_SHA"

# === REBUILD ===
# El backend corre con tsx pero resuelve @teros/* vía dist/; hay que reconstruir
# o quedaría con el dist/ del código malo.
log_step "Reinstalando dependencias y reconstruyendo packages..."
yarn install --frozen-lockfile
yarn --cwd packages/shared build
yarn --cwd packages/core build
yarn --cwd packages/mca-sdk build
yarn --cwd packages/backend build

# === RESTART ===
log_step "Reiniciando backend con PM2..."
pm2 restart teros-backend
pm2 save

# === VERIFICAR ===
log_step "Esperando a que el backend recuperado esté sano..."
if node scripts/wait-for-health.mjs "$HEALTH_URL" 30 2; then
    log_info "✅ Rollback completado: backend sano en $TARGET_SHA"
else
    log_error "❌ El backend NO está sano tras el rollback a $TARGET_SHA"
    log_error "Intervención manual: revisa 'pm2 logs teros-backend' y el estado de Mongo/Qdrant."
    exit 1
fi
