#!/bin/sh
# Teros all-in-one entrypoint (Railway).
#
# 1. Renders .secrets/system/*.json from environment variables — the
#    SecretsManager reads files only (no env-var fallback), so this is the
#    bridge between Railway variables and the backend's secret loading.
# 2. Prepares persistent directories under /data (Railway volume mount).
# 3. Optional flag seed (SEED_AUTO_GRANT=1) — dev environments skip the
#    private-beta waitlist for new signups.
# 4. Starts the backend (yarn sync + tsx src/index.ts) and waits for /health.
# 5. Renders the nginx config with the Railway-provided $PORT and starts nginx
#    in the foreground. If the backend dies, the container goes down with it
#    (restart policy handles the rest).
set -e

SECRETS_DIR=/app/.secrets/system
mkdir -p "$SECRETS_DIR"

write_secret() { # $1 = secret name, $2 = JSON body
  printf '%s' "$2" > "$SECRETS_DIR/$1.json"
  echo "[entrypoint] rendered secret: $1"
}

# encryption is the only fail-fast required secret (src/index.ts)
if [ -z "$SECRET_ENCRYPTION_KEY" ]; then
  echo "[entrypoint] FATAL: SECRET_ENCRYPTION_KEY is not set" >&2
  exit 1
fi
write_secret encryption "{\"masterKey\":\"$SECRET_ENCRYPTION_KEY\"}"

# Optional secrets — render only when the variable is provided
[ -n "$SECRET_SESSION_TOKEN" ]  && write_secret auth     "{\"sessionTokenSecret\":\"$SECRET_SESSION_TOKEN\"}"
[ -n "$SECRET_ADMIN_API_KEY" ]  && write_secret admin    "{\"apiKey\":\"$SECRET_ADMIN_API_KEY\"}"
[ -n "$SECRET_RESEND_API_KEY" ]  && write_secret email    "{\"resendApiKey\":\"$SECRET_RESEND_API_KEY\"}"
[ -n "$SECRET_FIREWORKS_API_KEY" ] && write_secret fireworks "{\"apiKey\":\"$SECRET_FIREWORKS_API_KEY\"}"

# database.json — MONGODB_URI (env) wins at runtime, but keep the secret file
# consistent for code paths that read it directly.
MONGO_URI_VALUE="${MONGODB_URI:-mongodb://localhost:27017}"
MONGO_DB_VALUE="${MONGODB_DATABASE:-teros}"
write_secret database "{\"uri\":\"$MONGO_URI_VALUE\",\"database\":\"$MONGO_DB_VALUE\"}"

# Persistent directories (Railway volume is mounted at /data)
mkdir -p "${VOLUMES_BASE_PATH:-/data/volumes}/workspaces" \
         "${UPLOADS_PATH:-/data/uploads}" \
         /data/agent-apps-objects

# Optional: seed access.auto-grant=true on dev environments (idempotent upsert).
# Run BEFORE the backend boots — syncRegistry never overwrites an existing
# defaultValue, so the seed survives every boot.
if [ "$SEED_AUTO_GRANT" = "1" ]; then
  echo "[entrypoint] seeding feature flags (access.auto-grant=true)"
  node /app/docker/railway/seed-flags.mjs || echo "[entrypoint] WARN: flag seed failed — continuing" >&2
fi

# Start the backend in the background. First boot runs the MCA catalog sync
# (87 manifests) before the listener opens — it takes a while.
#
# PORT OVERRIDE (critical): the backend reads `PORT` (src/config.ts), and
# Railway injects its own PORT (the public listener) into the container. Without
# this override the backend would grab Railway's PORT and nginx could never
# bind it — the entrypoint health-wait on the internal port would time out and
# crash-loop the container. Force the backend onto the internal BACKEND_PORT
# (default 3000) for this command only; the shell's PORT stays Railway's for
# the nginx render below.
cd /app/packages/backend
PORT="${BACKEND_PORT:-3000}" yarn start &
BACKEND_PID=$!

# Watchdog: if the backend exits, bring the container down (Railway restarts it).
# kill -0 polling — `wait` cannot be used here: the backend is a child of the
# main shell, not of this subshell, and `wait` on a non-child errors out
# immediately (which would kill the container at boot).
(
  while kill -0 $BACKEND_PID 2>/dev/null; do sleep 5; done
  echo "[entrypoint] backend exited — stopping container" >&2
  kill 1 2>/dev/null || true
) &

# Wait for the backend health endpoint (up to 10 minutes; first boot is slow)
BACKEND_PORT_VALUE="${BACKEND_PORT:-3000}"
i=0
until wget -q -O /dev/null "http://127.0.0.1:${BACKEND_PORT_VALUE}/health" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -ge 120 ]; then
    echo "[entrypoint] FATAL: backend did not become healthy within 10 minutes" >&2
    exit 1
  fi
  sleep 5
done
echo "[entrypoint] backend healthy on :${BACKEND_PORT_VALUE} — starting nginx"

# Render the nginx config with the Railway-provided port
NGINX_PORT_VALUE="${PORT:-8080}"
sed "s/__PORT__/${NGINX_PORT_VALUE}/g" \
  /app/docker/railway/nginx.conf.template > /etc/nginx/http.d/default.conf

exec nginx -g 'daemon off;'
