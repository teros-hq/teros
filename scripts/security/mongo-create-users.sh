#!/usr/bin/env bash
# datastore-isolation P0b — one-off: create Mongo role users on an EXISTING deployment.
#
# Why this exists: docker/mongo-init/ only runs on a FRESH data volume. A running
# deployment (pre/prod) keeps its volume, so the users must be created once here.
#
# Order on an existing volume (the official image starts mongod with --auth as
# soon as MONGO_INITDB_ROOT_USERNAME/PASSWORD are set):
#   1. Set MONGO_* in .env (see .env.example) and
#      `docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d mongodb`.
#   2. Run this script ONCE from the repo root. If `admin` has no users yet, the
#      root user is created first through the localhost exception (mongosh is
#      run INSIDE the container, which is allowed while zero users exist).
#   3. Then create the rw/ro users. Idempotent: existing users are skipped.
#   4. Point the backend at mongodb://<rw>:<pw>@.../teros?authSource=admin and restart it.
#
# Nothing here touches data. Read-only check afterwards:
#   docker exec -i "$CONTAINER" mongosh -u "$MONGO_RO_USER" -p "$MONGO_RO_PASSWORD" --authenticationDatabase admin --quiet --eval 'db.getSiblingDB("teros").stats().db'
set -euo pipefail

: "${MONGO_ROOT_USER:?set MONGO_ROOT_USER}"
: "${MONGO_ROOT_PASSWORD:?set MONGO_ROOT_PASSWORD}"
: "${MONGO_RW_PASSWORD:?set MONGO_RW_PASSWORD}"
: "${MONGO_RO_PASSWORD:?set MONGO_RO_PASSWORD}"
MONGO_RW_USER="${MONGO_RW_USER:-teros_rw}"
MONGO_RO_USER="${MONGO_RO_USER:-teros_ro}"
DB_NAME="${MONGO_INITDB_DATABASE:-teros}"
CONTAINER="${MONGO_CONTAINER:-teros-mongodb-1}"

mongo_in_container() { docker exec -i "$CONTAINER" mongosh --quiet "$@"; }

# Does `admin` already have users? (localhost exception: no auth needed while it has none)
USER_COUNT="$(mongo_in_container --eval 'db.getSiblingDB("admin").system.users.countDocuments()' 2>/dev/null || echo auth-required)"
if [[ "$USER_COUNT" == "0" ]]; then
  echo "[mongo-create-users] admin has no users — creating root via localhost exception"
  mongo_in_container --eval "db.getSiblingDB('admin').createUser({user: '$MONGO_ROOT_USER', pwd: '$MONGO_ROOT_PASSWORD', roles: [{role: 'root', db: 'admin'}]})"
fi

AUTH=(-u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin)
create_user() {
  local user="$1" pwd="$2" role="$3"
  mongo_in_container "${AUTH[@]}" --eval "
    const admin = db.getSiblingDB('admin');
    if (admin.getUser('$user')) { print('[mongo-create-users] $user exists — skipping'); }
    else { admin.createUser({user: '$user', pwd: '$pwd', roles: [{role: '$role', db: '$DB_NAME'}]}); print('[mongo-create-users] created $user ($role on $DB_NAME)'); }"
}
create_user "$MONGO_RW_USER" "$MONGO_RW_PASSWORD" readWrite
create_user "$MONGO_RO_USER" "$MONGO_RO_PASSWORD" read
echo "[mongo-create-users] done. Backend URI: mongodb://$MONGO_RW_USER:<pw>@mongodb:27017/$DB_NAME?authSource=admin"
