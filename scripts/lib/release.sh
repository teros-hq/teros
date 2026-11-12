#!/bin/bash
# Release directories + blue/green activation — sourced by deploy-server.sh
# and rollback.sh (spec DEP: REQ-1, REQ-3, REQ-4, REQ-8, REQ-11, REQ-12).
#
# Everything here is parameterized through environment variables so the bun
# tests (tests/unit/scripts/release-*.test.ts) can run it against a temporary
# git repo with stubbed pm2/nginx/curl on PATH:
#
#   APP_PATH             shared root + git checkout         /opt/teros
#   RELEASES_DIR         where worktrees live                $APP_PATH/releases
#   NGINX_TEROS_DIR      include dir nginx loads             /etc/nginx/teros
#   FRONTEND_ROOT        nginx root (becomes a symlink)      /var/www/teros
#   FRONTEND_RELEASES    frontend exports per release        /var/www/teros-releases
#   PUBLIC_HEALTH_URL    verified after the nginx switch     https://be.teros.ai/health
#   PM2_BIN / NGINX_BIN / CURL_BIN                           pm2 / nginx / curl
#   COLOR_PORT_BLUE / COLOR_PORT_GREEN / STABLE_PORT         10021 / 10022 / 10001
#   LEGACY_APP           single pre-blue/green pm2 app       teros-backend
#   HEALTH_ATTEMPTS / HEALTH_INTERVAL_S                      45 / 2  (90 s for the new color)
#   PUBLIC_HEALTH_ATTEMPTS                                   15      (30 s after the switch)
#   KEEP_RELEASES                                            3
#
# Expects the UI library (deploy-ui.sh) to be sourced first for ui_note/ui_warn/
# ui_run; falls back to plain echo when it is not (rollback from a bare shell).

APP_PATH="${APP_PATH:-/opt/teros}"
RELEASES_DIR="${RELEASES_DIR:-$APP_PATH/releases}"
NGINX_TEROS_DIR="${NGINX_TEROS_DIR:-/etc/nginx/teros}"
FRONTEND_ROOT="${FRONTEND_ROOT:-/var/www/teros}"
FRONTEND_RELEASES="${FRONTEND_RELEASES:-/var/www/teros-releases}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://be.teros.ai/health}"
PM2_BIN="${PM2_BIN:-pm2}"
NGINX_BIN="${NGINX_BIN:-nginx}"
CURL_BIN="${CURL_BIN:-curl}"
COLOR_PORT_BLUE="${COLOR_PORT_BLUE:-10021}"
COLOR_PORT_GREEN="${COLOR_PORT_GREEN:-10022}"
STABLE_PORT="${STABLE_PORT:-10001}"
LEGACY_APP="${LEGACY_APP:-teros-backend}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-45}"
HEALTH_INTERVAL_S="${HEALTH_INTERVAL_S:-2}"
PUBLIC_HEALTH_ATTEMPTS="${PUBLIC_HEALTH_ATTEMPTS:-15}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"

UPSTREAM_FILE="$NGINX_TEROS_DIR/10-upstream.conf"
STABLE_PORT_FILE="$NGINX_TEROS_DIR/20-stable-port.conf"

# Shared runtime state linked into every release (DEP-REQ-1). Files and dirs.
RELEASE_SHARED_PATHS=(
    .env
    .secrets
    data
    logs
    packages/backend/static/uploads
    packages/backend/static/downloads
    packages/backend/uploads
    packages/backend/media
    packages/backend/cache
    packages/backend/logs
)

# Outputs of release_activate
RELEASE_SWITCH_MS=0
RELEASE_ACTIVATED_COLOR=""
RELEASE_PREVIOUS_COLOR=""

# --- UI shims (deploy-ui.sh may not be loaded) -------------------------------
if ! type ui_note >/dev/null 2>&1; then
    ui_note() { echo "       $1"; }
    ui_warn() { echo "       ⚠ $1"; }
    ui_run()  { "$@"; }
fi
rel__err() { echo "       ✖ $1" >&2; }

# ---------------------------------------------------------------------------
# Release directories (DEP-REQ-1)
# ---------------------------------------------------------------------------
release_dir_for() { echo "$RELEASES_DIR/$1"; }

# Most recently modified release dir other than $1 (empty when none).
release_previous_dir() {
    local skip=${1:-} d
    [ -d "$RELEASES_DIR" ] || return 0
    # shellcheck disable=SC2012
    for d in $(ls -1t "$RELEASES_DIR" 2>/dev/null); do
        [ "$d" = "current" ] && continue
        [ -n "$skip" ] && [ "$RELEASES_DIR/$d" = "$skip" ] && continue
        [ -d "$RELEASES_DIR/$d/.git" ] || [ -f "$RELEASES_DIR/$d/.git" ] || continue
        echo "$RELEASES_DIR/$d"
        return 0
    done
}

# Active release dir via the `current` symlink (empty when none / legacy).
release_current_dir() {
    [ -L "$RELEASES_DIR/current" ] && readlink "$RELEASES_DIR/current" || true
}

# release_prepare <sha>  → RELEASE_DIR, RELEASE_REUSED (0|1), RELEASE_REUSED_FROM
release_prepare() {
    local sha=$1 dir prev
    dir=$(release_dir_for "$sha")
    mkdir -p "$RELEASES_DIR"
    if [ -e "$dir/.git" ]; then
        # Redeploy of a commit that already has a worktree: reuse it in place.
        ui_note "release directory exists — reusing $dir"
        ui_run git -C "$dir" checkout --detach -q "$sha"
    else
        ui_run git -C "$APP_PATH" worktree prune
        ui_run git -C "$APP_PATH" worktree add --detach -q "$dir" "$sha"
    fi
    release_link_shared "$dir"

    RELEASE_REUSED=0
    RELEASE_REUSED_FROM=""
    prev=$(release_previous_dir "$dir")
    if [ -n "$prev" ] && [ -d "$prev/node_modules" ] && [ ! -d "$dir/node_modules" ]; then
        if cmp -s "$prev/yarn.lock" "$dir/yarn.lock"; then
            release__hardlink_node_modules "$prev" "$dir"
            RELEASE_REUSED=1
            RELEASE_REUSED_FROM=$(basename "$prev")
            ui_note "node_modules hard-linked from $RELEASE_REUSED_FROM (lockfile unchanged)"
        else
            ui_note "lockfile changed since $(basename "$prev") — fresh install"
        fi
    fi
    RELEASE_DIR=$dir
}

# Hard-link every node_modules tree of <from> into <to> (root + workspaces).
# Hard links share inodes: safe because nothing writes inside node_modules at
# runtime, and yarn replaces files (unlink + create) rather than editing them.
release__hardlink_node_modules() {
    local from=$1 to=$2 nm rel
    while IFS= read -r nm; do
        rel=${nm#"$from"/}
        [ -d "$to/$(dirname "$rel")" ] || continue
        [ -e "$to/$rel" ] && continue
        cp -al "$nm" "$to/$rel"
    done < <(find "$from" -maxdepth 3 -type d -name node_modules -not -path '*/node_modules/*' 2>/dev/null)
}

# Replace each shared path inside <dir> with a symlink to $APP_PATH/<path>.
release_link_shared() {
    local dir=$1 p target
    for p in "${RELEASE_SHARED_PATHS[@]}"; do
        target="$APP_PATH/$p"
        case "$p" in
            .env) [ -e "$target" ] || : > "$target" ;;
            *)    [ -e "$target" ] || mkdir -p "$target" ;;
        esac
        mkdir -p "$(dirname "$dir/$p")"
        rm -rf "$dir/$p"
        ln -s "$target" "$dir/$p"
    done
}

# release_prune <active-dir>: keep the KEEP_RELEASES most recent, never active.
release_prune() {
    local active=$1 d n=0
    [ -d "$RELEASES_DIR" ] || return 0
    # shellcheck disable=SC2012
    for d in $(ls -1t "$RELEASES_DIR" 2>/dev/null); do
        [ "$d" = "current" ] && continue
        [ -d "$RELEASES_DIR/$d" ] || continue
        if [ "$RELEASES_DIR/$d" = "$active" ]; then continue; fi
        n=$((n + 1))
        if [ "$n" -ge "$KEEP_RELEASES" ]; then
            ui_note "removing old release $d"
            ui_run git -C "$APP_PATH" worktree remove --force "$RELEASES_DIR/$d" || rm -rf "$RELEASES_DIR/$d"
        fi
    done
    ui_run git -C "$APP_PATH" worktree prune
}

# ---------------------------------------------------------------------------
# Colors, pm2, nginx (DEP-REQ-3/4/12)
# ---------------------------------------------------------------------------
release_color_port() {
    case "$1" in
        blue)  echo "$COLOR_PORT_BLUE" ;;
        green) echo "$COLOR_PORT_GREEN" ;;
        *)     echo "$STABLE_PORT" ;;
    esac
}

release_other_color() { [ "$1" = "blue" ] && echo green || echo blue; }

# What the upstream file points at: blue | green | legacy (stable port) | none.
release_active_color() {
    [ -f "$UPSTREAM_FILE" ] || { echo none; return; }
    if grep -qE "127\.0\.0\.1:$COLOR_PORT_BLUE\b" "$UPSTREAM_FILE"; then echo blue
    elif grep -qE "127\.0\.0\.1:$COLOR_PORT_GREEN\b" "$UPSTREAM_FILE"; then echo green
    else echo legacy; fi
}

release_pm2_has() {
    "$PM2_BIN" jlist 2>/dev/null | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try { const a = JSON.parse(s); process.exit(a.some((p) => p.name === process.argv[1]) ? 0 : 1) }
  catch { process.exit(1) }
})' "$1"
}

release_write_upstream() {  # <color>
    local color=$1 port
    port=$(release_color_port "$color")
    mkdir -p "$NGINX_TEROS_DIR"
    cat > "$UPSTREAM_FILE" <<EOF
# Managed by scripts/lib/release.sh (spec DEP-REQ-4) — the active backend color.
# Do not edit by hand: the next deploy rewrites it.
# color: $color
upstream teros_backend {
    server 127.0.0.1:$port;
    keepalive 32;
}
EOF
}

release_write_stable_port() {
    mkdir -p "$NGINX_TEROS_DIR"
    cat > "$STABLE_PORT_FILE" <<EOF
# Managed by scripts/lib/release.sh (spec DEP-REQ-4) — the stable backend port.
# MCA containers on the execution host dial <core tunnel IP>:$STABLE_PORT for callbacks
# and their /mca WebSocket; before blue/green the backend itself listened here.
# Now nginx owns the port and proxies to whichever color is active, so a
# handoff never changes the address an MCA knows.
server {
    listen $STABLE_PORT;
    server_name _;

    client_max_body_size 100m;

    location / {
        proxy_pass http://teros_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
}

release_nginx_reload() {
    ui_run "$NGINX_BIN" -t && ui_run "$NGINX_BIN" -s reload
}

# Preflight for the nginx side (DEP-REQ-14): nginx must include our dir.
release_nginx_ready() {
    [ -f "$UPSTREAM_FILE" ] || return 1
    "$NGINX_BIN" -T 2>/dev/null | grep -q "upstream teros_backend" || return 1
    return 0
}

# release_poll_health <url> <expected-sha|""> <attempts> <interval-s>
# Ready = HTTP 200 + status "ok" + (when given) release == sha.
release_poll_health() {
    local url=$1 sha=$2 attempts=$3 interval=$4 i body
    for i in $(seq 1 "$attempts"); do
        body=$("$CURL_BIN" -sf -m 5 "$url" 2>/dev/null) || body=""
        if [ -n "$body" ] && node -e '
const [body, sha] = process.argv.slice(1)
try { const b = JSON.parse(body); process.exit(b.status === "ok" && (!sha || b.release === sha) ? 0 : 1) }
catch { process.exit(1) }' "$body" "$sha"; then
            RELEASE_HEALTH_SECONDS=$(( (i - 1) * interval ))
            return 0
        fi
        sleep "$interval"
    done
    return 1
}

# ---------------------------------------------------------------------------
# Activation — the handoff (DEP-REQ-3, DEP-REQ-12)
# ---------------------------------------------------------------------------
# release_activate <release-dir> <sha>
# Sets RELEASE_ACTIVATED_COLOR, RELEASE_PREVIOUS_COLOR, RELEASE_SWITCH_MS.
release_activate() {
    local dir=$1 sha=$2 active idle idle_port legacy=0 t0 t1
    active=$(release_active_color)
    case "$active" in
        none)
            rel__err "nginx upstream file $UPSTREAM_FILE missing — run the cutover runbook first"
            return 1 ;;
        legacy) legacy=1; idle=blue ;;
        blue|green) idle=$(release_other_color "$active") ;;
    esac
    idle_port=$(release_color_port "$idle")
    RELEASE_PREVIOUS_COLOR=$active
    RELEASE_ACTIVATED_COLOR=$idle

    # A stale idle color (previous activation died between switch and delete).
    if release_pm2_has "teros-backend-$idle"; then
        ui_note "stale teros-backend-$idle found — deleting it first"
        ui_run "$PM2_BIN" delete "teros-backend-$idle"
    fi

    # 1. Start the idle color from the new release.
    ui_note "starting teros-backend-$idle :$idle_port from $(basename "$dir")"
    if ! TEROS_RELEASE_DIR="$dir" TEROS_RELEASE="$sha" \
         ui_run "$PM2_BIN" start "$dir/ecosystem.prod.config.cjs" --only "teros-backend-$idle"; then
        release__abort_new "$idle" "pm2 start failed"
        return 1
    fi

    # 2. Wait until it is healthy AND answers with the new commit.
    if ! release_poll_health "http://127.0.0.1:$idle_port/health" "$sha" "$HEALTH_ATTEMPTS" "$HEALTH_INTERVAL_S"; then
        ui_warn "teros-backend-$idle did not report healthy release $sha within $((HEALTH_ATTEMPTS * HEALTH_INTERVAL_S))s"
        "$PM2_BIN" logs "teros-backend-$idle" --nostream --lines 40 >> "${UI_STEP_LOG:-/dev/null}" 2>&1 || true
        release__abort_new "$idle" "unhealthy"
        return 1
    fi
    ui_note "teros-backend-$idle healthy in ${RELEASE_HEALTH_SECONDS}s"

    # 3. Switch nginx.
    t0=$(release__now_ms)
    local backup
    backup=$(cat "$UPSTREAM_FILE")
    release_write_upstream "$idle"
    if ! release_nginx_reload; then
        printf '%s\n' "$backup" > "$UPSTREAM_FILE"
        release__abort_new "$idle" "nginx reload failed (upstream restored)"
        return 1
    fi

    # 4. Verify through the public URL.
    if ! release_poll_health "$PUBLIC_HEALTH_URL" "$sha" "$PUBLIC_HEALTH_ATTEMPTS" "$HEALTH_INTERVAL_S"; then
        ui_warn "public health did not report release $sha after the switch — switching back to $active"
        printf '%s\n' "$backup" > "$UPSTREAM_FILE"
        release_nginx_reload || true
        release__abort_new "$idle" "public verification failed (switched back)"
        return 1
    fi

    # 5. Stop the previous backend. Its graceful shutdown closes clients with
    #    1012; they reconnect straight into the new color.
    if [ "$legacy" = 1 ]; then
        if release_pm2_has "$LEGACY_APP"; then
            ui_note "stopping legacy $LEGACY_APP (frees :$STABLE_PORT)"
            ui_run "$PM2_BIN" delete "$LEGACY_APP"
        fi
        ui_note "installing stable-port listener :$STABLE_PORT"
        release_write_stable_port
        release_nginx_reload || { ui_warn "nginx reload failed after writing $STABLE_PORT_FILE — MCA callbacks need it"; }
    else
        if release_pm2_has "teros-backend-$active"; then
            ui_note "stopping teros-backend-$active"
            ui_run "$PM2_BIN" delete "teros-backend-$active"
        fi
    fi
    t1=$(release__now_ms)
    RELEASE_SWITCH_MS=$(( t1 - t0 ))
    ui_run "$PM2_BIN" save

    mkdir -p "$RELEASES_DIR"
    ln -sfn "$dir" "$RELEASES_DIR/current.tmp" && mv -Tf "$RELEASES_DIR/current.tmp" "$RELEASES_DIR/current" 2>/dev/null \
        || { rm -f "$RELEASES_DIR/current"; ln -sfn "$dir" "$RELEASES_DIR/current"; }
    return 0
}

release__abort_new() {  # <color> <reason>
    rel__err "activation aborted: $2 — previous backend untouched"
    "$PM2_BIN" delete "teros-backend-$1" >> "${UI_STEP_LOG:-/dev/null}" 2>&1 || true
}

release__now_ms() {
    local ns
    ns=$(date +%s%N 2>/dev/null)
    case "$ns" in *N*|"") echo $(( $(date +%s) * 1000 )) ;; *) echo $(( ns / 1000000 )) ;; esac
}

# ---------------------------------------------------------------------------
# Frontend (DEP-REQ-8)
# ---------------------------------------------------------------------------
# release_frontend_publish <sha> <dist-dir>: copy the export into its release dir.
release_frontend_publish() {
    local sha=$1 dist=$2 target
    target="$FRONTEND_RELEASES/$sha"
    mkdir -p "$FRONTEND_RELEASES"
    rm -rf "$target.tmp"
    cp -r "$dist" "$target.tmp"
    rm -rf "$target"
    mv "$target.tmp" "$target"
}

# release_frontend_switch <sha>: atomically point FRONTEND_ROOT at the release.
release_frontend_switch() {
    local sha=$1 target tmp
    target="$FRONTEND_RELEASES/$sha"
    tmp="$FRONTEND_ROOT.switching"
    [ -d "$target" ] || { rel__err "frontend release $target does not exist"; return 1; }
    if [ -d "$FRONTEND_ROOT" ] && [ ! -L "$FRONTEND_ROOT" ]; then
        local legacy="$FRONTEND_RELEASES/legacy-$(date +%Y%m%d-%H%M%S)"
        ui_note "first run: moving the real directory $FRONTEND_ROOT to $legacy"
        mkdir -p "$FRONTEND_RELEASES"
        mv "$FRONTEND_ROOT" "$legacy"
    fi
    ln -sfn "$target" "$tmp"
    # rename(2) over an existing symlink is atomic; -T keeps mv from descending
    # into the target directory (GNU). Fallback for non-GNU mv.
    mv -Tf "$tmp" "$FRONTEND_ROOT" 2>/dev/null || { rm -f "$FRONTEND_ROOT"; mv "$tmp" "$FRONTEND_ROOT"; }
}

# release_frontend_verify <sha> <url>: the page served at <url> MUST be the
# release's own index.html. Moving the symlink proves nothing if nginx serves
# another root — prod did, from 2026-11-06 to 2026-11-09, and every deploy
# reported the switch as done (DEP-REQ-8).
release_frontend_verify() {
    local sha=$1 url=$2 served expected
    expected=$(cat "$FRONTEND_RELEASES/$sha/index.html") || { rel__err "release $sha has no index.html"; return 1; }
    served=$("$CURL_BIN" -sf -m 10 "$url") || { rel__err "$url is not responding"; return 1; }
    if [ "$served" != "$expected" ]; then
        rel__err "$url does not serve release ${sha:0:8} — nginx must serve $FRONTEND_ROOT"
        return 1
    fi
}

# Keep the KEEP_RELEASES most recent frontend releases (never the active one).
release_frontend_prune() {
    local active d n=0
    active=$(readlink "$FRONTEND_ROOT" 2>/dev/null || true)
    [ -d "$FRONTEND_RELEASES" ] || return 0
    # shellcheck disable=SC2012
    for d in $(ls -1t "$FRONTEND_RELEASES" 2>/dev/null); do
        [ "$FRONTEND_RELEASES/$d" = "$active" ] && continue
        n=$((n + 1))
        if [ "$n" -ge "$KEEP_RELEASES" ]; then
            rm -rf "$FRONTEND_RELEASES/$d"
        fi
    done
}

# ---------------------------------------------------------------------------
# Execution host (DEP-REQ-10)
# ---------------------------------------------------------------------------
# release_runtime_changed <repo> <old-sha> <new-sha>
# True when the diff touches what MCA containers run from: their sources
# (bind-mounted mcas/), the runtime images (docker/) or the SDK they load.
release_runtime_changed() {
    local repo=$1 old=$2 new=$3
    [ "$old" != "$new" ] || return 1
    git -C "$repo" diff --name-only "$old" "$new" -- mcas docker packages/mca-sdk | grep -q .
}
