#!/bin/bash
# Deploy log UI — sourced by the deploy scripts (spec DEP-REQ-13).
#
# One fixed-column line per step (outcome, n/total, name, elapsed, detail)
# under phase headings, never wider than 80 columns. On a TTY the running step
# is a single live line (spinner, elapsed time and, once the step has recorded
# durations, a progress bar towards its usual time) that becomes the final
# line. Sub-command output and notes go to a per-step log file; a failed step
# prints the tail of its log. A closing line ends the run.
# Colors when stdout is a TTY or FORCE_COLOR/CI is set, unless NO_COLOR or FORCE_COLOR=0.
# Degrades to plain text otherwise (the GitHub Actions log over ssh gets
# FORCE_COLOR=1 from the workflow).
#
# Portable to bash 3.2 (macOS, where the bun tests run): no associative arrays,
# no ${var,,}, no $EPOCHREALTIME. Widths are computed byte-wise so they hold
# under a C locale too (the servers' default).
#
# API
#   ui_init  "<name>" "<run-dir>" <total-steps>   # once; creates the run dir
#   ui_history "<timings-file>" "<script-key>"    # record/read step durations
#   ui_banner "<context>" ["<line>"...]            # header
#   ui_phase "<name>" ["<hint>"]                   # phase heading; a hint highlights it
#   ui_step  "<name>"                              # starts a step (name: 22 chars, stable)
#   ui_run   <cmd> [args...]                       # runs with output -> step log; returns its code
#   ui_note  "<text>"                              # step log + live line
#   ui_warn  "<text>"                              # ⚠ line under the step (step ends as warn)
#   ui_ok    ["<detail>"]                          # ends the step ✔
#   ui_skip  "<reason>"                            # ends the step ⊘
#   ui_bg    "<label>"                             # ends the step ⇢ (work continues in background)
#   ui_fail  ["<detail>"]                          # ends the step ✖ and prints the log tail
#   ui_done  "<headline>" "<facts>" ["<line>"...]  # closing line of a completed run
#   ui_abort "<what>" <exit-code> ["<line>"...]    # closing line of a failed run
#   ui_signals_off / ui_signals_on                 # ignore / handle INT, TERM, HUP (DEP-REQ-17)
#   ui_log_path                                    # current step's log file
#   ui_fmt_duration <ms>                           # 420ms -> "0.4s", 63240 -> "1m03s"

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
UI_NAME=""
UI_RUN_DIR=""
UI_TOTAL=0
UI_START_MS=0
UI_STEP_N=0
UI_STEP_START_MS=0
UI_STEP_NAME=""
UI_STEP_LOG=""
UI_STEP_OPEN=0
UI_STEP_WARNED=0
UI_STEP_EXPECTED=""
UI_STEP_WARNS=()
UI_TAIL_SHOWN=0
UI_WARN_COUNT=0
UI_TICK_PID=""
UI_RUN_PID=""
UI_SIGNAL=""
UI_HISTORY_FILE=""
UI_HISTORY_KEY=""
UI_HISTORY_RUNS=5
UI_NAME_W=22
UI_DETAIL_W=36
UI_BAR_CELLS=12
UI_TAIL_LINES=40

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
ui__detect_color() {
    if [ -n "${NO_COLOR:-}" ]; then return 1; fi
    if [ "${FORCE_COLOR:-}" = 0 ]; then return 1; fi   # FORCE_COLOR=0 means off, as in chalk
    if [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ] || [ -n "${CI:-}" ]; then return 0; fi
    return 1
}

if ui__detect_color; then
    UI_COLOR=1
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_DIM=$'\033[38;5;245m'; C_VIOLET=$'\033[38;5;141m'; C_LILAC=$'\033[38;5;183m'
    C_GREEN=$'\033[38;5;114m'; C_RED=$'\033[38;5;203m'; C_YELLOW=$'\033[38;5;221m'
    C_BLUE=$'\033[38;5;75m'; C_CYAN=$'\033[38;5;117m'
    C_PILL=$'\033[48;5;141m\033[38;5;16m\033[1m'
else
    UI_COLOR=0
    C_RESET=""; C_BOLD=""; C_DIM=""; C_VIOLET=""; C_LILAC=""; C_GREEN=""; C_RED=""
    C_YELLOW=""; C_BLUE=""; C_CYAN=""; C_PILL=""
fi
UI_TTY=0
[ -t 1 ] && UI_TTY=1

# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------
ui__now_ms() {
    local ns
    ns=$(date +%s%N 2>/dev/null)
    case "$ns" in
        *N*|"") echo $(( $(date +%s) * 1000 )) ;;
        *) echo $(( ns / 1000000 )) ;;
    esac
}

ui_fmt_duration() {
    local ms=$1
    if [ "$ms" -lt 60000 ]; then
        # one decimal below a minute
        printf '%d.%ds' $(( ms / 1000 )) $(( (ms % 1000) / 100 ))
    elif [ "$ms" -lt 3600000 ]; then
        printf '%dm%02ds' $(( ms / 60000 )) $(( (ms % 60000) / 1000 ))
    else
        printf '%dh%02dm' $(( ms / 3600000 )) $(( (ms % 3600000) / 60000 ))
    fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
ui__slug() {
    echo "$1" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40
}

# Number of characters of a UTF-8 string, whatever the locale: every byte that
# is not a continuation byte (10xxxxxx) starts one.
ui__chars() {
    local LC_ALL=C s=$1 i=0 n=0 len
    len=${#s}
    while [ $i -lt "$len" ]; do
        case "${s:$i:1}" in
            [$'\200'-$'\277']) ;;
            *) n=$((n + 1)) ;;
        esac
        i=$((i + 1))
    done
    echo "$n"
}

# ui__fit <text> <max> -> the text, cut to max characters with a trailing …
ui__fit() {
    local LC_ALL=C s=$1 max=$2 i=0 n=0 len out=""
    if [ "$(ui__chars "$s")" -le "$max" ]; then printf '%s' "$s"; return 0; fi
    len=${#s}
    while [ $i -lt "$len" ]; do
        case "${s:$i:1}" in
            [$'\200'-$'\277']) ;;
            *) n=$((n + 1)); [ "$n" -ge "$max" ] && break ;;
        esac
        out="$out${s:$i:1}"
        i=$((i + 1))
    done
    printf '%s…' "$out"
}

ui__rule() {  # ui__rule <char> <n>
    local i=0 out=""
    while [ $i -lt "$2" ]; do out="$out$1"; i=$((i+1)); done
    printf '%s' "$out"
}

# Detail text in the dim color, with the backend colors in their own.
ui__paint() {
    local s=" $1 "
    if [ "$UI_COLOR" = 1 ]; then
        s=${s// blue / ${C_BLUE}blue${C_DIM} }
        s=${s// green / ${C_GREEN}green${C_DIM} }
    fi
    s=${s# }; s=${s% }
    printf '%s%s%s' "$C_DIM" "$s" "$C_RESET"
}

# ui__row <symbol> <name-style> <duration-style> <duration> <painted-detail>
ui__row() {
    local line
    line=$(printf ' %s%s  %s%2d/%d%s  %s%-*s%s %s%6s%s' \
        "$1" "$C_RESET" "$C_DIM" "$UI_STEP_N" "$UI_TOTAL" "$C_RESET" \
        "$2" "$UI_NAME_W" "$(ui__fit "$UI_STEP_NAME" "$UI_NAME_W")" "$C_RESET" \
        "$3" "$4" "$C_RESET")
    if [ -n "$5" ]; then line="$line  $5"; fi
    printf '%s' "$line"
}

# ---------------------------------------------------------------------------
# Step durations (DEP-REQ-13): <epoch> <script> <step> <ms>, tab-separated
# ---------------------------------------------------------------------------
ui_history() {
    UI_HISTORY_FILE=$1
    UI_HISTORY_KEY=$2
}

ui__record() {  # ui__record <step-slug> <ms>
    [ -n "$UI_HISTORY_FILE" ] || return 0
    printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$UI_HISTORY_KEY" "$1" "$2" >> "$UI_HISTORY_FILE"
}

# ui__expected <step-slug> -> median ms of its last UI_HISTORY_RUNS records, or nothing
ui__expected() {
    [ -n "$UI_HISTORY_FILE" ] && [ -f "$UI_HISTORY_FILE" ] || return 0
    awk -F'\t' -v k="$UI_HISTORY_KEY" -v s="$1" '$2 == k && $3 == s { print $4 }' "$UI_HISTORY_FILE" \
        | tail -n "$UI_HISTORY_RUNS" | sort -n \
        | awk '{ a[NR] = $1 } END { if (NR) print a[int((NR + 1) / 2)] }'
}

# ui__bar <elapsed-ms> <expected-ms> -> "━━━━━━━━──── of ~47.0s" / "━━━━━━━━━━━━ +28.6s over ~38.0s"
ui__bar() {
    local cur=$1 exp=$2 filled i=0 out="" col=$C_VIOLET hint
    [ "$exp" -gt 0 ] || exp=1
    filled=$(( cur * UI_BAR_CELLS / exp ))
    [ "$filled" -gt "$UI_BAR_CELLS" ] && filled=$UI_BAR_CELLS
    if [ "$cur" -gt "$exp" ]; then
        col=$C_YELLOW
        hint="${C_YELLOW}+$(ui_fmt_duration $(( cur - exp ))) over ~$(ui_fmt_duration "$exp")"
    else
        hint="${C_DIM}of ~$(ui_fmt_duration "$exp")"
    fi
    while [ $i -lt "$UI_BAR_CELLS" ]; do
        if [ $i -lt "$filled" ]; then out="$out${col}━"; else out="$out${C_DIM}─"; fi
        i=$((i + 1))
    done
    printf '%s %s%s' "$out" "$hint" "$C_RESET"
}

# ---------------------------------------------------------------------------
# Live line (TTY only): a background ticker redraws the running step in place
# ---------------------------------------------------------------------------
UI_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

ui__live_start() {
    [ "$UI_TTY" = 1 ] || return 0
    : > "$UI_RUN_DIR/.live"
    printf '\033[?25l\033[?7l'   # no cursor, no auto-wrap: a narrow terminal cuts the line
    (
        i=0
        while kill -0 $$ 2>/dev/null; do
            ms=$(( $(ui__now_ms) - UI_STEP_START_MS ))
            if [ -n "$UI_STEP_EXPECTED" ]; then
                detail=$(ui__bar "$ms" "$UI_STEP_EXPECTED")
            else
                detail=$(ui__paint "$(ui__fit "$(cat "$UI_RUN_DIR/.live" 2>/dev/null)" "$UI_DETAIL_W")")
            fi
            printf '\r\033[2K%s' "$(ui__row "${C_VIOLET}${UI_FRAMES[$(( i % 10 ))]}" "$C_BOLD" "$C_LILAC" "$(ui_fmt_duration "$ms")" "$detail")"
            i=$((i + 1))
            sleep 0.1
        done
    ) &
    UI_TICK_PID=$!
}

ui__live_stop() {
    [ -n "$UI_TICK_PID" ] || return 0
    kill "$UI_TICK_PID" 2>/dev/null || true
    wait "$UI_TICK_PID" 2>/dev/null || true
    UI_TICK_PID=""
    rm -f "$UI_RUN_DIR/.live"
    printf '\r\033[2K\033[?7h\033[?25h'
}

# ---------------------------------------------------------------------------
# Interruption (DEP-REQ-17)
# ---------------------------------------------------------------------------
# INT, TERM and HUP stop the sub-command in progress with its children and
# exit with 128 + signal; the script's EXIT trap then closes the run through
# ui_abort, which reads UI_SIGNAL. ui_signals_off ignores the three signals —
# an ignored signal is inherited by every command the script runs — for the
# sections that must not be cut (the activation, the EXIT trap itself).
ui__kill_tree() {
    local child
    for child in $(pgrep -P "$1" 2>/dev/null); do ui__kill_tree "$child"; done
    kill -TERM "$1" 2>/dev/null || true
}

ui__on_signal() {  # ui__on_signal <name> <exit-code>
    UI_SIGNAL=$1
    if [ -n "$UI_RUN_PID" ]; then ui__kill_tree "$UI_RUN_PID"; fi
    exit "$2"
}

ui_signals_on() {
    trap 'ui__on_signal INT 130' INT
    trap 'ui__on_signal TERM 143' TERM
    trap 'ui__on_signal HUP 129' HUP
}

ui_signals_off() { trap '' INT TERM HUP; }

# ---------------------------------------------------------------------------
# Header and phases
# ---------------------------------------------------------------------------
ui_init() {
    UI_NAME=$1
    UI_RUN_DIR=$2
    UI_TOTAL=$3
    UI_START_MS=$(ui__now_ms)
    mkdir -p "$UI_RUN_DIR"
    ui_signals_on
}

# ui_banner "<context>" ["<line>"...] — the expected total joins the first line
ui_banner() {
    local context=$1 usual first=1
    shift
    usual=$(ui__expected _total)
    echo ""
    printf ' %s◆ %s%s  %s\n' "${C_VIOLET}${C_BOLD}" "$UI_NAME" "$C_RESET" "$context"
    while [ $# -gt 0 ]; do
        if [ "$first" = 1 ] && [ -n "$usual" ]; then
            printf '   %s%s · usually ~%s%s\n' "$C_DIM" "$1" "$(ui_fmt_duration "$usual")" "$C_RESET"
        else
            printf '   %s%s%s\n' "$C_DIM" "$1" "$C_RESET"
        fi
        first=0
        shift
    done
}

# ui_phase "<name>" ["<hint>"] — with a hint the phase is the highlighted one
ui_phase() {
    if [ "$UI_STEP_OPEN" = 1 ]; then ui_ok; fi
    echo ""
    if [ -n "${2:-}" ]; then
        printf ' %s %s %s %s%s%s\n' "$C_PILL" "$1" "$C_RESET" "$C_DIM" "$2" "$C_RESET"
    else
        printf ' %s%s%s %s%s%s\n' "${C_VIOLET}${C_BOLD}" "$1" "$C_RESET" "$C_DIM" "$(ui__rule '─' $(( 64 - ${#1} )))" "$C_RESET"
    fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
ui_step() {
    if [ "$UI_STEP_OPEN" = 1 ]; then ui_ok; fi
    UI_STEP_N=$((UI_STEP_N + 1))
    UI_STEP_NAME=$1
    UI_STEP_START_MS=$(ui__now_ms)
    UI_STEP_OPEN=1
    UI_STEP_WARNED=0
    UI_STEP_WARNS=()
    UI_TAIL_SHOWN=0
    UI_STEP_LOG=$(printf '%s/%02d-%s.log' "$UI_RUN_DIR" "$UI_STEP_N" "$(ui__slug "$1")")
    : > "$UI_STEP_LOG"
    UI_STEP_EXPECTED=$(ui__expected "$(ui__slug "$1")")
    ui__live_start
}

ui_log_path() { echo "$UI_STEP_LOG"; }

# Outside a step (library functions called from a bare shell) notes and
# warnings are printed as they come.
ui_note() {
    if [ "$UI_STEP_OPEN" != 1 ]; then printf '      %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; return 0; fi
    printf '· %s\n' "$1" >> "$UI_STEP_LOG"
    if [ -n "$UI_TICK_PID" ]; then printf '%s' "$1" > "$UI_RUN_DIR/.live"; fi
    return 0
}

ui_warn() {
    if [ "$UI_STEP_OPEN" != 1 ]; then printf '      %s⚠ %s%s\n' "$C_YELLOW" "$1" "$C_RESET"; return 0; fi
    printf '⚠ %s\n' "$1" >> "$UI_STEP_LOG"
    UI_STEP_WARNED=1
    UI_STEP_WARNS+=("$1")
}

# Run a command with its output captured to the step log. Returns the
# command's exit code (the caller's `set -e` then aborts through the EXIT
# trap, whose ui_abort fails the step and prints the log tail).
# The command runs in the background and is waited for: bash defers a trap
# until a foreground command ends, but `wait` returns at once, so an
# interruption takes effect immediately (DEP-REQ-17). Stdin is passed through.
ui_run() {
    local code=0
    if [ -z "$UI_STEP_LOG" ]; then
        # Used before ui_init/ui_step (library functions called from a bare shell).
        [ -n "$UI_RUN_DIR" ] || UI_RUN_DIR=$(mktemp -d /tmp/teros-ui.XXXXXX)
        UI_STEP_LOG="$UI_RUN_DIR/00-pre.log"
    fi
    {
        printf '\n+ '
        printf '%q ' "$@"
        printf '\n'
    } >> "$UI_STEP_LOG"
    "$@" <&0 >> "$UI_STEP_LOG" 2>&1 &
    UI_RUN_PID=$!
    while :; do
        code=0
        wait "$UI_RUN_PID" || code=$?
        kill -0 "$UI_RUN_PID" 2>/dev/null || break   # gone: that was its exit code
    done
    UI_RUN_PID=""
    if [ "$code" -ne 0 ]; then
        printf '✖ command failed (exit %d): %s\n' "$code" "$*" >> "$UI_STEP_LOG"
    fi
    return $code
}

ui__tail() {
    [ -s "$UI_STEP_LOG" ] || return 0
    [ "$UI_TAIL_SHOWN" = 1 ] && return 0
    UI_TAIL_SHOWN=1
    printf '      %s╭─ last %d lines of %s%s\n' "$C_DIM" "$UI_TAIL_LINES" "$UI_STEP_LOG" "$C_RESET"
    tail -n "$UI_TAIL_LINES" "$UI_STEP_LOG" | sed "s/^/      ${C_DIM}│${C_RESET} /"
    printf '      %s╰─%s\n' "$C_DIM" "$C_RESET"
}

# ui__close <symbol-with-color> <status> <duration-column> [detail]
# duration-column: empty = the elapsed time.
ui__close() {
    local sym=$1 status=$2 durcol=$3 text=${4:-}
    local ms detail="" w
    ui__live_stop
    ms=$(( $(ui__now_ms) - UI_STEP_START_MS ))
    UI_STEP_OPEN=0
    [ "$status" = ok ] && ui__record "$(ui__slug "$UI_STEP_NAME")" "$ms"
    [ "$status" = warn ] && UI_WARN_COUNT=$((UI_WARN_COUNT + 1))

    # A detail that fits goes on the step line; a longer one, in full, under it.
    if [ -n "$text" ] && [ "$(ui__chars "$text")" -le "$UI_DETAIL_W" ]; then
        detail=$(ui__paint "$text"); text=""
    fi
    printf '%s\n' "$(ui__row "$sym" "" "$C_DIM" "${durcol:-$(ui_fmt_duration "$ms")}" "$detail")"
    if [ -n "$text" ]; then printf '      %s\n' "$(ui__paint "$text")"; fi
    if [ "${#UI_STEP_WARNS[@]}" -gt 0 ]; then
        for w in "${UI_STEP_WARNS[@]}"; do printf '      %s⚠ %s%s\n' "$C_YELLOW" "$w" "$C_RESET"; done
    fi
    UI_STEP_WARNS=()
}

ui_ok() {
    if [ "$UI_STEP_WARNED" = 1 ]; then
        ui__close "${C_YELLOW}⚠" warn "" "${1:-}"
    else
        ui__close "${C_GREEN}✔" ok "" "${1:-}"
    fi
}
ui_skip() { ui__close "${C_DIM}⊘" skip "skip" "${1:-}"; }
ui_bg()   { ui__close "${C_CYAN}⇢" bg "bg" "${1:-}"; }
ui_fail() {
    ui__close "${C_RED}✖" fail "" "${1:-}"
    [ -n "$UI_SIGNAL" ] || ui__tail   # an interrupted step did not fail: no tail
}

# ---------------------------------------------------------------------------
# Closing line
# ---------------------------------------------------------------------------
# ui_done "<headline>" "<facts>" ["<line>"...]
#   ✔ <headline> · <total> · <facts>  ♥        (⚠ and the warning count when a step warned)
ui_done() {
    local headline=$1 facts=${2:-} total_ms sym=$C_GREEN glyph="✔" tail=""
    shift; [ $# -gt 0 ] && shift
    if [ "$UI_STEP_OPEN" = 1 ]; then ui_ok; fi
    total_ms=$(( $(ui__now_ms) - UI_START_MS ))
    ui__record _total "$total_ms"
    if [ "$UI_WARN_COUNT" -gt 0 ]; then
        sym=$C_YELLOW; glyph="⚠"
        tail=" ${C_YELLOW}· $UI_WARN_COUNT warning$([ "$UI_WARN_COUNT" -gt 1 ] && echo s)${C_RESET}"
    fi
    echo ""
    printf ' %s%s %s%s %s· %s%s%s%s  %s♥%s\n' "${sym}${C_BOLD}" "$glyph" "$headline" "$C_RESET" \
        "$C_DIM" "$(ui_fmt_duration "$total_ms")" "$C_RESET" \
        "${facts:+ $(ui__paint "· $facts")}" "$tail" "$C_VIOLET" "$C_RESET"
    while [ $# -gt 0 ]; do printf '   %s\n' "$(ui__paint "$1")"; shift; done
    echo ""
}

# ui_abort "<what>" <exit-code> ["<line>"...]
#   ✖ <what> failed at <n>/<total> <step> · <total> · exit <code>
#   ✖ <what> interrupted (SIGTERM) at <n>/<total> <step> · <total>
ui_abort() {
    local what=$1 code=$2 total_ms where verdict="failed" suffix
    shift 2
    suffix=" · exit $code"
    if [ -n "$UI_SIGNAL" ]; then verdict="interrupted (SIG$UI_SIGNAL)"; suffix=""; fi
    if [ "$UI_STEP_OPEN" = 1 ]; then ui_fail; fi
    total_ms=$(( $(ui__now_ms) - UI_START_MS ))
    if [ "$UI_STEP_N" -gt 0 ]; then
        where="at $UI_STEP_N/$UI_TOTAL $UI_STEP_NAME"
    else
        where="before the first step"
    fi
    echo ""
    printf ' %s✖ %s %s%s %s %s· %s%s%s\n' "${C_RED}${C_BOLD}" "$what" "$verdict" "$C_RESET" "$where" \
        "$C_DIM" "$(ui_fmt_duration "$total_ms")" "$suffix" "$C_RESET"
    while [ $# -gt 0 ]; do printf '   %s\n' "$(ui__paint "$1")"; shift; done
    echo ""
}
