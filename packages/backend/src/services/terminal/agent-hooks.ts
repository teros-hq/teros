/**
 * Coding-agent state from the agent itself, with no network hop.
 *
 * Claude Code runs hooks on its lifecycle events. Inside a Teros terminal the
 * hook command `teros-agent-state <state>` writes the state onto its own tmux
 * pane (`tmux set -p -t $TMUX_PANE @agent_state …`); the backend's control
 * client is subscribed to that option and gets `%subscription-changed` within
 * a second. No callback URL, no token, and it survives backend restarts (the
 * value lives in tmux). Outside Teros terminals ($TMUX_PANE unset — e.g. the
 * agent's own bash tool) the helper is a silent no-op.
 *
 * The helper lives on the persistent volume (/app-data/bin, on PATH in the
 * bash image), so it serves both the terminal host and the bash MCA container
 * and needs no image rebuild to change.
 *
 * State vocabulary (herdr's): working · blocked (needs you: permission,
 * question) · done (turn finished, waiting for the next prompt) · idle.
 */

import { replaceControls } from "./snapshot"

/** The helper script, installed as /app-data/bin/teros-agent-state. */
export const AGENT_STATE_SCRIPT = `#!/bin/bash
# teros-agent-state <state> — record a coding agent's state on its Teros
# terminal (tmux pane option @agent_state = "<state>|<unix time>|<message>").
# Called by Claude Code hooks; reads the hook's JSON on stdin when there is one.
# Never fails: a broken hook must not disturb the agent.
state="\${1:-}"
[ -n "$state" ] && [ -n "$TMUX_PANE" ] || exit 0
msg=""
if [ ! -t 0 ]; then
  input="$(timeout 1 head -c 65536 2>/dev/null)"
  msg="$(printf '%s' "$input" | jq -r '.message // empty' 2>/dev/null | head -c 300 | tr '\\n\\t|' '   ')"
fi
# Claude's "waiting for your input" idle notification means the turn is over.
case "$msg" in *"waiting for your input"*) state=done ;; esac
# Its session id: a session woken from sleep resumes this conversation (claude --resume).
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9-' | head -c 64)"
[ -n "$sid" ] && tmux set -p -t "$TMUX_PANE" @agent_session "$sid" >/dev/null 2>&1
# Milliseconds: two states within one second must still differ (waits see each one).
tmux set -p -t "$TMUX_PANE" @agent_state "$state|$(date +%s%3N)|$msg" >/dev/null 2>&1
exit 0
`

/** Claude Code hook events → state written by the helper. */
export const CLAUDE_HOOK_STATES: Record<string, string> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Notification: "blocked",
  Stop: "done",
  SessionEnd: "ended",
}

/**
 * Merge our hooks into ~/.claude/settings.json without touching the user's
 * own: entries whose command mentions teros-agent-state are replaced, the
 * rest is kept as-is. Idempotent. Runs with the container's node.
 */
const MERGE_SETTINGS_JS = `
const fs = require('fs')
const path = process.env.HOME + '/.claude/settings.json'
let settings = {}
try { settings = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}
if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {}
settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
const want = ${JSON.stringify(CLAUDE_HOOK_STATES)}
for (const [event, state] of Object.entries(want)) {
  const keep = (Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes('teros-agent-state')) }))
    .filter((g) => g.hooks.length)
  const ours = { hooks: [{ type: 'command', command: '/app-data/bin/teros-agent-state ' + state }] }
  if (event === 'PreToolUse' || event === 'PostToolUse') ours.matcher = '*'
  settings.hooks[event] = [...keep, ours]
}
fs.mkdirSync(process.env.HOME + '/.claude', { recursive: true })
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\\n')
`

/** Shell script (run with `bash -s` in the terminal host) that installs the helper and the hooks. */
export function claudeHooksSetupScript(): string {
  return [
    "set -e",
    "mkdir -p /app-data/bin",
    "cat > /app-data/bin/teros-agent-state <<'TEROS_EOF'",
    AGENT_STATE_SCRIPT.trimEnd(),
    "TEROS_EOF",
    "chmod +x /app-data/bin/teros-agent-state",
    "node - <<'TEROS_EOF'",
    MERGE_SETTINGS_JS.trim(),
    "TEROS_EOF",
  ].join("\n")
}

/**
 * Skip Claude Code's first-run screens (theme picker, security notes) — they
 * are a one-time onboarding of the CLI, not a choice about this session — and,
 * for a session a Teros agent opens, the folder trust check of its working
 * directory: the agent would answer it anyway, and it is the workspace's own
 * folder. A person's own sessions keep the trust check. Merges into
 * ~/.claude.json, leaves everything else as it is. Idempotent.
 */
export function claudeOnboardingScript(opts: { trustDir?: string } = {}): string {
  const trust = JSON.stringify(opts.trustDir ?? "")
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    "const path = process.env.HOME + '/.claude.json'",
    "let cfg = {}",
    "try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}",
    "if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {}",
    "if (cfg.hasCompletedOnboarding !== true) cfg.hasCompletedOnboarding = true",
    `const trust = ${trust}`,
    "if (trust) {",
    "  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}",
    "  cfg.projects[trust] = { ...(cfg.projects[trust] || {}), hasTrustDialogAccepted: true }",
    "}",
    "fs.writeFileSync(path, JSON.stringify(cfg, null, 2))",
    "TEROS_EOF",
  ].join("\n")
}

/**
 * What a "Claude Code session" types into its fresh shell: install Claude
 * Code with the official installer when it isn't there yet (it lands in
 * ~/.local on the persistent volume), then start it. Typed, not exec'd, so
 * quitting Claude leaves a working shell in the same session.
 */
export const CLAUDE_LAUNCH_LINE =
  'export PATH="$HOME/.local/bin:$PATH"; command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash; clear; claude'

/** Presets a session can be created with (terminal.create `preset`). */
export type TerminalPreset = "shell" | "claude" | "codex" | "opencode"

export function isPreset(value: unknown): value is TerminalPreset {
  return value === "shell" || value === "claude" || value === "codex" || value === "opencode"
}

/** Coding-agent presets: what is typed into the fresh shell (installed on first use, on the persistent volume). */
export const AGENT_LAUNCH_LINES: Record<Exclude<TerminalPreset, "shell">, string> = {
  claude: CLAUDE_LAUNCH_LINE,
  codex:
    'export PATH="$HOME/.local/bin:$PATH"; command -v codex >/dev/null || npm i -g @openai/codex; clear; codex',
  opencode: "command -v opencode >/dev/null || npm i -g opencode-ai; clear; opencode",
}

export const AGENT_TITLES: Record<Exclude<TerminalPreset, "shell">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
}

/**
 * Pre-approve an API key for Claude Code (what its own "use this API key?"
 * prompt records: the key's last 20 characters in ~/.claude.json), so a
 * session started with the user's key goes straight to the prompt. The
 * script comes through stdin; the suffix never appears in a command line.
 */
export function claudeApproveKeyScript(apiKey: string, configDir?: string): string {
  const suffix = JSON.stringify(apiKey.slice(-20))
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    configDir
      ? `const path = ${JSON.stringify(`${configDir}/.claude.json`)}`
      : "const path = process.env.HOME + '/.claude.json'",
    "let cfg = {}",
    "try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}",
    "cfg.customApiKeyResponses = cfg.customApiKeyResponses || { approved: [], rejected: [] }",
    `const s = ${suffix}`,
    "if (!cfg.customApiKeyResponses.approved.includes(s)) cfg.customApiKeyResponses.approved.push(s)",
    "cfg.customApiKeyResponses.rejected = (cfg.customApiKeyResponses.rejected || []).filter((x) => x !== s)",
    "fs.writeFileSync(path, JSON.stringify(cfg, null, 2))",
    "TEROS_EOF",
  ].join("\n")
}

export function claudeSessionPrepScript(cwd: string): string {
  const trust = cwd === "/workspace" || cwd.startsWith("/workspace/") ? cwd : ""
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    "const path = process.env.HOME + '/.claude.json'",
    "let cfg = {}",
    "try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}",
    "cfg.hasCompletedOnboarding = true",
    "if (!cfg.theme) cfg.theme = 'dark'",
    `const trust = ${JSON.stringify(trust)}`,
    "if (trust) {",
    "  cfg.projects = cfg.projects || {}",
    "  cfg.projects[trust] = { ...(cfg.projects[trust] || {}), hasTrustDialogAccepted: true }",
    "}",
    "fs.writeFileSync(path, JSON.stringify(cfg, null, 2))",
    "TEROS_EOF",
  ].join("\n")
}

// ── Waking a session from sleep ──────────────────────────────────────────────

/** Shells: nothing to restart besides the prompt itself. */
const SHELL_COMMANDS = new Set(["", "bash", "sh", "zsh", "fish", "dash", "-bash", "login"])

/**
 * The line that brings Claude Code back on its conversation: `--resume <id>`
 * when its hooks reported the session id and the transcript is still there
 * (two Claude Code sessions in one directory would make `--continue` pick the
 * wrong one), `--continue` (latest conversation of the directory) otherwise.
 * No `clear`: the old scrollback printed above stays visible.
 */
export function claudeResumeLine(sessionId: string, onMiss: "continue" | "fresh" = "continue"): string {
  const id = /^[A-Za-z0-9-]{8,64}$/.test(sessionId) ? sessionId : ""
  const otherwise = onMiss === "fresh" ? "claude" : "claude --continue"
  const run = id
    ? `if ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl >/dev/null 2>&1; then claude --resume ${id}; else ${otherwise}; fi`
    : otherwise
  return `export PATH="$HOME/.local/bin:$PATH"; command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash; ${run}`
}

/** What a sleeping session runs again when it wakes, and what it can't bring back. */
export interface ResumePlan {
  /** Coding agent restarted (its credentials are injected as at create), null for none. */
  agent: Exclude<TerminalPreset, "shell"> | null
  /** Typed into the new shell, null for nothing. */
  launch: string | null
  /** What ran at sleep time and is not restarted (e.g. "npm run dev"), null for nothing. */
  notRestored: string | null
  /** One sentence for people and agents. */
  message: string
}

/**
 * The cwd a waking session's new pane opens in (Pablo, 2-nov: cwd único). A
 * runner session — bridge-created (`createdBy` "agent:…") with a coding
 * agent to restart — always comes back in the single boot cwd /workspace,
 * whatever directory Claude had `cd`ed into before it fell asleep: Claude
 * Code resolves `--resume` from the launch cwd's project dir (runner
 * transcripts live under `-workspace`), and a repo dir can be untrusted —
 * the trust dialog then hangs an unattended session (fb_53dc509e82f7b0c0).
 * A person's session keeps its own cwd while it still exists.
 */
export function wakeCwdOf(
  bridge: boolean,
  agent: string | null,
  recordCwd: string | undefined,
  cwdOk: boolean,
): string {
  if (bridge && agent) return "/workspace"
  return recordCwd && cwdOk ? recordCwd : "/workspace"
}

/**
 * Decide how a session comes back from what was in its foreground when it fell
 * asleep: Claude Code resumes its conversation, Codex / opencode start again,
 * a shell is just a shell; anything else (a dev server, vim) is not restarted
 * and is reported.
 */
export function resumePlan(r: { command: string; foreground: string }): ResumePlan {
  const command = r.command.trim()
  if (command === "claude")
    return {
      agent: "claude",
      launch: null, // claudeResumeLine(agentSession): the caller has the id
      notRestored: null,
      message: "Resumed after sleep: Claude Code is back on its conversation.",
    }
  if (command === "codex" || command === "opencode")
    return {
      agent: command,
      launch: AGENT_LAUNCH_LINES[command].replace("clear; ", ""),
      notRestored: null,
      message: `Resumed after sleep: ${AGENT_TITLES[command]} started again (a new conversation).`,
    }
  if (SHELL_COMMANDS.has(command))
    return { agent: null, launch: null, notRestored: null, message: "Resumed after sleep." }
  const what = (r.foreground || command).slice(0, 200)
  return {
    agent: null,
    launch: null,
    notRestored: what,
    message: `Resumed after sleep. "${what}" was running and was not restarted: start it again if you need it.`,
  }
}

/** Single-quote a string for the shell. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Script (run with `bash -s` in the new host) that writes the saved scrollback
 * to `file` for the first shell to print, and says whether `cwd` still exists
 * ("cwd-ok"). The text goes through base64: whatever it contains, it is data.
 */
export function resumeHistoryScript(file: string, history: string, cwd: string): string {
  const b64 = Buffer.from(history, "utf8").toString("base64").replace(/.{76}/g, "$&\n")
  return [
    `base64 -d > ${shq(file)} <<'TEROS_EOF'`,
    b64,
    "TEROS_EOF",
    `[ -d ${shq(cwd)} ] && echo cwd-ok`,
  ].join("\n")
}

/**
 * The first command of a woken session's window: print the old scrollback
 * dimmed, a one-line "resumed after sleep" marker (and what was not
 * restarted), then become the interactive shell.
 */
export function resumeWindowCommand(file: string, notRestored: string | null): string {
  const marker = notRestored
    ? `— resumed after sleep · not restarted: ${replaceControls(notRestored, " ")} —`
    : "— resumed after sleep —"
  const script = `printf '\\033[2m'; cat ${shq(file)} 2>/dev/null; rm -f ${shq(file)}; printf '\\033[0m\\n\\033[2m%s\\033[0m\\n' "$1"; exec bash`
  return `bash -c ${shq(script)} teros-resume ${shq(marker)}`
}
