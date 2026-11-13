#!/usr/bin/env npx tsx

/**
 * mca.teros.terminal — terminal sessions a Teros agent drives while the user watches
 *
 * Thin wrapper over the backend's sessions (PtyManager: tmux windows in the
 * workspace's terminal host). The backend owns the sessions; this MCA exposes
 * them as agent tools whose answers are plain text for the model (what
 * happened + the rendered screen + the next step) with the same data as
 * structuredContent for scripts.
 *
 * Transport note: the backend does not expose terminal.* actions over the MCA
 * HTTP callback. The supported path is the admin_request bridge on the
 * persistent WebSocket connection (McaConnectionManager.handleAdminRequest →
 * WsRouter.dispatch), which is what backendAction() uses. context.backend (the
 * HTTP McaBackendClient) is still used where an HTTP callback exists — e.g.
 * workspaceAppList() to discover the workspace's bash app that hosts the PTYs.
 *
 * Tools → backend actions:
 *   terminal-create   → terminal.create (+ terminal.wait until=ready for coding agents)
 *   terminal-prompt   → terminal.write (paste) + terminal.wait until=turn
 *   terminal-run      → terminal.write + terminal.wait until=exit + terminal.read
 *   terminal-wait     → terminal.wait   (agent turn / ready, exit, quiet, screen text)
 *   terminal-screen   → terminal.screen (+ terminal.status)
 *   terminal-read     → terminal.read   (output log + cursor)
 *   terminal-write    → terminal.write  (low level, paste-aware)
 *   terminal-send-key → terminal.input  (named keys, sequences)
 *   terminal-wait-for → terminal.waitFor (regex on the log, kept for compatibility)
 *   terminal-list     → terminal.list
 *   terminal-show     → terminal.reveal (bring it up in the user's Terminal window)
 *   terminal-destroy  → terminal.destroy
 *
 * Every tool call must answer within the backend's 120 s MCA call timeout:
 * waits are capped at MAX_STATE_WAIT_MS and say "still working, call again".
 *
 * Sessions are kept until destroyed. Idle ones freeze, then sleep (saved, no
 * machine) — the tools that use a session wake it first (wakeForUse) and say
 * so; a Claude Code session back from sleep is waited on until it is ready.
 */

import { HealthCheckBuilder, McaServer, type ToolContext } from "@teros/mca-sdk"
import {
  AGENT_COMMANDS,
  runTool,
  agentName,
  backendAction,
  commandOutput,
  CONTROL_LABELS,
  type ControlOutcome,
  controlButtons,
  controlNote,
  controlRequestText,
  type Driver,
  type HandedBack,
  isOwnText,
  isWsConnected,
  KEY_HELP,
  needsLoginText,
  newTerminalId,
  noAccessText,
  type RenderedScreen,
  type ResumeInfo,
  renderCarriageReturns,
  reply,
  resolveKey,
  screenChanges,
  screenText,
  sessionLine,
  showSequence,
  statusLine,
  refusedWriteText,
  releaseControlText,
  wokeNote,
} from "./lib"

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_WAIT_TIMEOUT_MS = 10_000
/** Longest single wait: the backend's call to this MCA times out at 120 s. */
const MAX_STATE_WAIT_MS = 100_000
/** Extra time the bridge call gets over the backend-side wait. */
const BRIDGE_HEADROOM_MS = 15_000
/** terminal.create: a cold start (machine warmup, host clone) is slow. */
const CREATE_TIMEOUT_MS = 90_000
/** What one terminal-create may spend in total (create + waiting for the agent). */
const TOOL_BUDGET_MS = 105_000
const READY_WAIT_MS = 90_000
const PROMPT_WAIT_MS = 90_000
const CONTROL_WAIT_MS = 90_000
const DEFAULT_READ_LINES = 200
/** terminal-prompt: the typed prompt has landed when the screen is quiet this long. */
const TYPE_SETTLE_MS = 300
const TYPE_SETTLE_TIMEOUT_MS = 5_000
/**
 * How long terminal-create waits for the post-`cd` sentinel before declaring
 * the cwd not applied. Only paid when the cd fails — a healthy shell echoes
 * the sentinel in well under 100 ms.
 */
const CWD_VERIFY_TIMEOUT_MS = 2_000

interface TerminalCreateResult {
  terminalId: string
  cols?: number
  rows?: number
  reused?: boolean
  host?: boolean
  persistent?: boolean
}

interface TerminalReadResult {
  output: string
  cursor: number
  truncated?: boolean
  notFound?: boolean
  driver?: Driver
  handedBack?: HandedBack
}

interface TerminalWaitForResult {
  matched: boolean
  line: string | null
  lineIndex: number | null
  cursor: number | null
}

interface SessionInfo {
  terminalId: string
  containerId: string
  createdAt: string
  lastActivity: string
  alive: boolean
  bufferSize: number
  ownerWorkspaceId?: string
  title?: string
  kind?: string
  command?: string | null
  persistent?: boolean
  /** awake, frozen (idle, paused) or sleeping (saved, no machine): both wake when used. */
  lifecycle?: "awake" | "frozen" | "sleeping"
  space?: "personal" | "shared"
  sleptAt?: string | null
  resumed?: ResumeInfo | null
  agentState?: { state: string; message?: string } | null
  needsAuth?: string | null
  createdBy?: string
  viewers?: number
  watchers?: Array<{ id: string; kind: "human" | "agent"; name: string }>
  driver?: Driver
  conflict?: { ids: string[]; at: number } | null
  openedBy?: "person" | "agent"
  agentControl?: boolean
  shared?: boolean
}

// =============================================================================
// HELPERS
// =============================================================================

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function optionalInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return num
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && typeof (error as any).code === "string") {
    return (error as any).code
  }
  return undefined
}

/**
 * User-facing error thrown when the workspace has no bash app at all — Terminal
 * sessions live inside the bash app's container, so without it the tool cannot
 * work at all. Message follows MCA error convention (English, actionable).
 */
const BASH_APP_REQUIRED_MESSAGE =
  "Terminal requires the Bash app (mca.teros.bash) to be installed in this workspace. " +
  "Install the Bash app and try again."

/**
 * User-facing error thrown when the workspace HAS a bash app but it is in a
 * non-active, non-recoverable state (error / stopping / unknown). Distinct
 * from BASH_APP_REQUIRED_MESSAGE so the user is not told to "install" an app
 * that is already installed (audit 2026-10-18, finding T-003).
 */
function bashAppNotReadyMessage(status: string): string {
  return (
    `The Bash app (mca.teros.bash) is installed in this workspace but its current status is "${status}". ` +
    "Wait a moment and try again, or open the Bash app to check its state."
  )
}

/**
 * Resolve the appId of a bash app in the caller's workspace — terminal.create
 * spawns the PTY inside the bash container of the app it is given (it warms up
 * `bash_bash` and looks up the `mca-teros-bash-*` container), so the bash app
 * is the one that must be passed.
 *
 * Outcomes (audit 2026-10-18, findings T-001 + T-003):
 *   1. Bash app found, status 'active'  → its appId, resolved: true.
 *   2. Bash app found, status 'standby' → its appId, resolved: true. The
 *      backend's ensureContainerRunning already forces a spawn via bash_bash
 *      warmup, so a standby app recovers on its own — no reason to fail.
 *   3. Bash app found, any other status (error, stopping, …) → throw
 *      bashAppNotReadyMessage(status): the app exists, the user should not be
 *      told to install it.
 *   4. Discovery ran, no bash app at all → throw BASH_APP_REQUIRED_MESSAGE
 *      (fail-fast: falling through to terminal.create with the terminal appId
 *      can never work — the terminal container is mca-teros-terminal-*, not
 *      mca-teros-bash-*).
 *   5. Discovery unavailable (no callbackUrl / transport error) → best-effort
 *      fallback to the execution appId, resolved: false. The backend may still
 *      resolve a container in environments where the callback is not wired
 *      (e.g. integration tests); if not, its error surfaces instead.
 */
async function resolveBashAppId(
  context: ToolContext,
): Promise<{ appId: string; resolved: boolean }> {
  const workspaceId = context.execution.workspaceId
  const backend = context.backend

  if (workspaceId && backend?.workspaceAppList) {
    let apps: Array<{ mcaId?: string; status?: string; appId?: string }>
    try {
      const result = await backend.workspaceAppList(workspaceId)
      apps = result.apps ?? []
    } catch (error) {
      // Transport-level failure (backend unreachable, callback not wired):
      // discovery is best-effort — fall through to the execution appId.
      console.warn(
        `[mca.teros.terminal] workspaceAppList failed, falling back to own appId: ${errorMessage(error)}`,
      )
      return { appId: context.execution.appId, resolved: false }
    }

    const bashApp = apps.find((app) => app.mcaId === "mca.teros.bash")

    if (bashApp?.appId) {
      const status = bashApp.status ?? "unknown"
      // Active and standby both work: standby recovers via the warmup the
      // backend performs on every terminal.create (bash_bash spawn).
      if (status === "active" || status === "standby") {
        return { appId: bashApp.appId, resolved: true }
      }
      // App exists but is in a non-recoverable-by-warmup state — tell the
      // user the actual status instead of asking them to install the app.
      throw new Error(bashAppNotReadyMessage(status))
    }

    // Discovery succeeded and there is no bash app at all — fail fast with an
    // actionable message instead of letting the backend hit a container lookup
    // that can never succeed (audit 2026-10-18, finding T-001).
    throw new Error(BASH_APP_REQUIRED_MESSAGE)
  }

  // No workspaceId or no backend callback — discovery cannot run at all.
  return { appId: context.execution.appId, resolved: false }
}

/** Shell-quote a path for an initial `cd` (single-quote escaping). */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** Random alphanum suffix for one-shot sentinels (not cryptographic). */
function randomSuffix(length = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/**
 * Apply the requested cwd to a fresh session and verify it for real
 * (audit 2026-10-18, finding T-005): send `cd <cwd> && echo <sentinel>` and
 * wait for the sentinel. The sentinel is only printed when the cd succeeds,
 * so:
 *   - sentinel matched        → cd applied; cwdError stays null.
 *   - sentinel not matched    → cd failed (or the shell is pathologically
 *     slow); the buffer is read once to surface the shell's own error line
 *     (e.g. `bash: cd: /x: No such file or directory`) as cwdError.
 *   - transport/timeout error → cd may not have reached the session at all;
 *     cwdApplied stays false and the error message is reported.
 *
 * Returns the fields terminal-create reports back to the agent. `startCursor`
 * is the buffer position just past the verification exchange — passing it as
 * `since` to terminal-read/terminal-wait-for skips the cd echo entirely.
 */
async function applyCwd(
  terminalId: string,
  cwd: string,
): Promise<{ cwdApplied: boolean; cwdError: string | null; startCursor: number | null }> {
  const nonce = randomSuffix()
  const sentinel = `TEROS-CWD-OK-${nonce}`

  let writeCursor: number | undefined
  try {
    const write = await backendAction<{ ok: boolean; cursor?: number }>("terminal.write", {
      terminalId,
      // The empty '' splits the sentinel in the typed line: the shell prints
      // it whole, the echo of the command line can never match it.
      data: `cd ${shellQuote(cwd)} && echo TEROS-CWD-OK-''${nonce}`,
      sendEnter: true,
    })
    writeCursor = write.cursor
  } catch (error) {
    // The cd never reached the session — nothing to verify.
    return { cwdApplied: false, cwdError: errorMessage(error), startCursor: null }
  }

  try {
    // No explicit fromLine: the backend starts the search at this write's
    // cursor, so the echoed command line can never self-match (T-004).
    //
    // The `$` anchor matters: the echoed command line CONTAINS the sentinel
    // (`... && echo TEROS-CWD-OK-xxx`) and, while it has no trailing newline
    // yet, the backend evaluates it as the pending virtual line — which sits
    // exactly at the write cursor, so an unanchored pattern matches the echo
    // instantly (observed: waitFor resolving in 3ms on a failed cd). The real
    // sentinel output is a line of its own that ENDS with the sentinel; the
    // echo always keeps the typed text after it (plus the next prompt), so
    // `$` excludes it.
    const wait = await backendAction<TerminalWaitForResult>(
      "terminal.waitFor",
      { terminalId, pattern: `${sentinel}$`, timeoutMs: CWD_VERIFY_TIMEOUT_MS, softTimeout: true },
      CWD_VERIFY_TIMEOUT_MS + 15_000,
    )
    if (wait.matched) {
      return { cwdApplied: true, cwdError: null, startCursor: wait.cursor }
    }
    // Timeout: the cd failed — read the exchange window for the shell's error.
    const read = await backendAction<TerminalReadResult>("terminal.read", {
      terminalId,
      ...(writeCursor !== undefined ? { since: writeCursor } : {}),
    })
    return {
      cwdApplied: false,
      cwdError: extractCdError(read.output, sentinel),
      startCursor: read.cursor,
    }
  } catch (error) {
    // The verification itself failed to run (transport/bridge error) — the
    // flag must not claim the cd was applied.
    return { cwdApplied: false, cwdError: errorMessage(error), startCursor: writeCursor ?? null }
  }
}

/**
 * Pick the shell's own error line out of the cd exchange output. The output
 * contains the echoed command line (which mentions the sentinel) plus, on
 * failure, the shell error (e.g. `bash: cd: /x: No such file or directory`).
 */
function extractCdError(output: string, sentinel: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l.includes("cd:") && !l.includes(sentinel))
  return line ?? "cd did not complete (no shell error captured — slow shell?)"
}

// =============================================================================
// SERVER
// =============================================================================

const VERSION = "2.1.0"

const server = new McaServer({
  id: "mca.teros.terminal",
  name: "Terminal",
  version: VERSION,
})

{
  const register = server.tool.bind(server)
  server.tool = ((name: string, config: Parameters<typeof register>[1]) =>
    register(name, {
      ...config,
      handler: async (args, context) => {
        try {
          return await runTool(context?.execution?.agentId, () => config.handler(args, context))
        } catch (error) {
          const terminalId = (args as { terminalId?: unknown } | undefined)?.terminalId
          if (errorCode(error) === "FORBIDDEN_TERMINAL" && typeof terminalId === "string")
            throw new Error(noAccessText(terminalId))
          if (errorCode(error) !== "WHEEL_HELD") throw error
          return reply(refusedWriteText(errorMessage(error)), {
            refused: true,
            reason: "person-typing",
            message: errorMessage(error),
          })
        }
      },
    })) as typeof server.tool
}

/** Last screen rows returned per session (terminal-screen onlyChanges). */
const lastScreens = new Map<string, string[]>()

/** The rendered screen block every answer that shows a screen ends with. */
function screenBlock(terminalId: string, screen: RenderedScreen | null): string {
  if (!screen) return ""
  lastScreens.set(terminalId, screen.lines)
  return `\n--- screen (${screen.cols}x${screen.rows}) ---\n${screenText(screen)}\n--- end of screen ---`
}

function defaultTitle(title: unknown, agent: string | undefined, cwd: string | undefined): string {
  if (typeof title === "string" && title.trim()) return title.trim().slice(0, 200)
  const dir = cwd ? ` · ${cwd.replace(/\/+$/, "").split("/").pop() || "/"}` : ""
  return `${agent ? agentName(agent) : "Shell"} (agent)${dir}`
}

/** What terminal.wait answers. */
interface WaitResult {
  /** A question or menu on the screen waiting for an answer, if any. */
  question: string | null
  met: boolean
  reason: string
  message?: string
  driver?: Driver
  driverChanged?: Driver | null
  handedBack?: HandedBack
  waitedMs: number
  alive: boolean
  command: string | null
  agentState: { state: string; message?: string } | null
  needsAuth: string | null
  screen: RenderedScreen | null
}

async function waitState(
  terminalId: string,
  until: string,
  timeoutMs: number,
  extra: Record<string, unknown> = {},
): Promise<WaitResult> {
  return backendAction<WaitResult>(
    "terminal.wait",
    { terminalId, until, timeoutMs, ...extra },
    timeoutMs + BRIDGE_HEADROOM_MS,
  )
}

/**
 * Make sure a session runs before a tool uses it (terminal.status wake:true)
 * and say so when it did not. A coding agent brought back from sleep is
 * waited on until it is ready for input again (up to `readyBudgetMs`), so a
 * prompt never lands in the shell it is started from.
 */
async function wakeForUse(
  terminalId: string,
  readyBudgetMs = READY_WAIT_MS,
): Promise<{ status: SessionInfo; note: string; woke: string | null }> {
  let r: { status: SessionInfo; woke?: string }
  try {
    r = await backendAction("terminal.status", { terminalId, wake: true }, CREATE_TIMEOUT_MS)
  } catch (error) {
    if (/timed? ?out/i.test(errorMessage(error)))
      throw new Error(
        `Session ${terminalId} is waking up from sleep (its machine is starting). Call the tool again in a moment.`,
      )
    throw error
  }
  let status = r.status
  if (r.woke === "sleeping" && status.resumed?.agent) {
    await waitState(terminalId, "ready", Math.max(5_000, readyBudgetMs))
    status = (await backendAction<{ status: SessionInfo }>("terminal.status", { terminalId }))
      .status
  }
  return { status, note: wokeNote(r.woke, status.resumed), woke: r.woke ?? null }
}

/** One sentence on where a wait left the session, and what to do next. */
function describeWait(
  terminalId: string,
  until: string,
  r: WaitResult,
  /** The coding agent the wait is about (it may have left the foreground). */
  agent?: string | null,
): string {
  const who = agentName(agent ?? r.needsAuth ?? r.command)
  const secs = `${(r.waitedMs / 1000).toFixed(1)} s`
  const asked = r.message ? `: "${r.message}"` : ""
  switch (r.reason) {
    case "done":
      return `${who} finished its turn (after ${secs}). Its answer is on the screen below. Next: terminal-prompt with the next task, or terminal-prompt text="/exit" to quit it.`
    case "blocked":
      return `${who} is waiting for an answer${asked}. Read the options on the screen, then answer with terminal-send-key (e.g. keys ["1"] or ["down","enter"]) or terminal-prompt, and terminal-wait until="turn" again.`
    case "ready":
      return `${who} is ready for a prompt. Next: terminal-prompt with terminalId "${terminalId}".`
    case "needs-login":
      return needsLoginText(agent ?? r.needsAuth ?? r.command, terminalId)
    case "exited":
      return until === "exit"
        ? `The command finished; the shell prompt is back (after ${secs}).`
        : `${who} is not running any more (back at the shell). Start it again with terminal-create agent=…, or use the shell.`
    case "not-started":
      return `${who} did not start a turn (nothing happened for ${secs}). Expected after a slash command such as /clear; otherwise look at the screen — the prompt may have gone to a dialog or still sit in the input box — and send it again with terminal-prompt if it is not in the conversation.`
    case "quiet":
      return `The screen settled (no output for a while, after ${secs}).`
    case "matched":
      return `The screen shows what you waited for (after ${secs}).`
    case "ended":
      return "The session ended (its shell exited or it was closed)."
    case "driver": {
      const d = r.driverChanged ?? r.driver
      if (d?.kind === "human")
        return `${d.name || "A person"} switched this session to "${CONTROL_LABELS.off}" or started typing in it (after ${secs}): your wait stopped and your keys would be refused while they type. Don't type into this session: wait (terminal-wait again returns when control changes), or ask with terminal-request-control (they get ${controlButtons()}).`
      return r.handedBack
        ? "You may type in this session again."
        : `Control of this session changed (after ${secs}); ${d?.kind === "agent" ? `${d.name || "an agent"} types in it` : "nobody is typing in it"} now. Look at the screen before you go on.`
    }
    default: {
      const now = r.needsAuth
        ? `${agentName(r.needsAuth)} shows its login screen`
        : r.agentState
          ? `${who} is ${r.agentState.state}`
          : r.command
            ? `${r.command} is running`
            : "nothing changed"
      const again =
        until === "turn"
          ? `call terminal-wait until="turn" to keep waiting`
          : `call terminal-wait until="${until}" again, or look at the screen`
      return `Still waiting after ${secs} (${now}). Not an error: ${again}.`
    }
  }
}

function waitLead(r: WaitResult): string {
  return r.reason === "driver" && !r.handedBack ? "" : controlNote(r)
}

function waitData(r: WaitResult, terminalId: string) {
  return {
    terminalId,
    met: r.met,
    reason: r.reason,
    message: r.message ?? null,
    waitedMs: r.waitedMs,
    alive: r.alive,
    command: r.command,
    agentState: r.agentState,
    needsAuth: r.needsAuth,
    question: r.question ?? null,
    driver: r.driver ?? null,
    handedBack: r.handedBack ?? null,
    screen: r.screen ? screenText(r.screen) : null,
  }
}

function clampTimeout(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = optionalInt(args, name) ?? fallback
  if (value <= 0 || value > max) throw new Error(`${name} must be between 1 and ${max}`)
  return value
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool("-health-check", {
  annotations: { readOnlyHint: true },
  description:
    "Internal health check tool. Verifies WebSocket connectivity to the backend terminal API.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const builder = new HealthCheckBuilder({}).setVersion(VERSION)

    if (!isWsConnected()) {
      builder.addIssue("DEPENDENCY_UNAVAILABLE", "Not connected to backend WebSocket", {
        type: "auto_retry",
        description: "WebSocket connection to the backend is not established",
      })
      return builder.build()
    }

    try {
      await backendAction("terminal.list")
    } catch (error: any) {
      builder.addIssue("DEPENDENCY_UNAVAILABLE", `terminal.list failed: ${error.message}`, {
        type: "auto_retry",
        description: "Backend terminal API temporarily unavailable",
      })
    }

    return builder.build()
  },
})

// =============================================================================
// TOOLS
// =============================================================================

const AGENT_PRESETS = ["claude", "codex", "opencode"] as const

server.tool("terminal-create", {
  annotations: {
    readOnlyHint: false,
    summary: "Open a terminal session (a shell, or Claude Code / Codex / opencode)",
    group: "Terminal",
  },
  description:
    "Open a terminal session in the workspace's Linux machine (the same workspace files and tools " +
    "as the Bash app). It is a shared terminal: it runs in the workspace's machine with the " +
    "workspace's home, never in a person's personal terminal. " +
    'It is yours: its "Agent" switch is on, and the workspace\'s members can see it, ' +
    "each session in its own Terminal window (show, default true, opens or focuses that window for " +
    'the user); to type in it they switch it to "Agent off". With agent="claude" (or "codex", ' +
    '"opencode") the session starts that coding agent (installing it on first use) and waits until ' +
    "it is ready for a prompt — then use terminal-prompt. Claude Code runs on the API key of the " +
    "workspace owner's Anthropic provider in Teros; with none it shows its login screen: stop and " +
    "tell the user (Teros never asks for, stores or shares a Claude sign-in). Without agent you get " +
    "a bash shell — use terminal-run for commands. " +
    "Each call opens a NEW session: check terminal-list first and reuse yours. Sessions are kept " +
    "until terminal-destroy: idle ones sleep and wake (same directory while it still exists, " +
    "Claude Code on its conversation) the next time a tool uses them.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: [...AGENT_PRESETS],
        description:
          'Start a coding agent in the session: "claude" (Claude Code), "codex" or "opencode". ' +
          "The call returns once it is ready for a prompt (or says what it waits for).",
      },
      cwd: {
        type: "string",
        description:
          "Working directory (default /workspace). For a shell, verified: cwdApplied tells " +
          'whether the cd worked and cwdError carries the shell error (e.g. "No such file or directory").',
      },
      title: {
        type: "string",
        description:
          'Short label the user sees on the window and in the "Sessions" list — set one (e.g. "deploy logs", "fix login bug")',
      },
      show: {
        type: "boolean",
        description:
          "Open or focus this session's Terminal window in the user's app so they can watch (default: true)",
      },
      cols: { type: "number", description: "Terminal width in columns (default: 120)" },
      rows: { type: "number", description: "Terminal height in rows (default: 40)" },
    },
  },
  handler: async (args, context) => {
    const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined
    const agent = typeof args.agent === "string" && args.agent ? args.agent : undefined
    if (agent && !(AGENT_PRESETS as readonly string[]).includes(agent)) {
      throw new Error(`agent must be one of: ${AGENT_PRESETS.join(", ")} (or omit it for a shell)`)
    }
    // Resolve defaults HERE so the advertised defaults are the ones applied
    // whatever the backend's own fallback is (audit 2026-10-18, T-006).
    const effCols = optionalInt(args, "cols") ?? 120
    const effRows = optionalInt(args, "rows") ?? 40
    const show = args.show !== false
    const started = Date.now()

    const { appId, resolved } = await resolveBashAppId(context)
    const terminalId = newTerminalId()

    let result: TerminalCreateResult
    try {
      result = await backendAction<TerminalCreateResult>(
        "terminal.create",
        {
          terminalId,
          appId,
          cols: effCols,
          rows: effRows,
          ...(agent ? { preset: agent } : {}),
          // An agent's directory goes to the window itself (typing `cd` into its prompt would be a message).
          ...(agent && cwd ? { cwd } : {}),
          // Every session gets a real label: identical "Agent shell" rows look like duplicates.
          title: defaultTitle(args.title, agent, cwd),
          reveal: show,
          // The MCA reads output with terminal.read/screen; no JSON output stream needed.
          subscribe: false,
        },
        CREATE_TIMEOUT_MS,
      )
    } catch (error) {
      // A cold start (first session of the workspace: machine warmup) can
      // outlast the call; the backend finishes it under this same id, so
      // the session is not lost and must not be opened twice.
      if (/timed? ?out/i.test(errorMessage(error))) {
        const text =
          `Session ${terminalId} is still opening (the workspace's terminal machine is starting up). ` +
          `Do not create another one: call terminal-wait with terminalId "${terminalId}" and ` +
          `until="${agent ? "ready" : "quiet"}".`
        return reply(text, { terminalId, status: "starting", agent: agent ?? null })
      }
      throw error
    }

    const base = {
      terminalId: result.terminalId,
      status: "ready",
      cols: result.cols ?? effCols,
      rows: result.rows ?? effRows,
      reused: result.reused ?? false,
      host: result.host ?? false,
      persistent: result.persistent ?? false,
      shown: show,
      bashAppId: appId,
      bashAppResolved: resolved,
    }
    const shownNote = show ? " The user can watch it in its own Terminal window." : ""

    if (agent) {
      // Wait for the agent with what is left of this call's budget.
      const budget = Math.max(5_000, TOOL_BUDGET_MS - (Date.now() - started))
      const wait = await waitState(terminalId, "ready", Math.min(budget, READY_WAIT_MS))
      const name = agentName(agent)
      const head =
        wait.reason === "timeout"
          ? `Opened session ${terminalId}; ${name} is still starting (the first use installs it, about a minute).${shownNote} Next: terminal-wait with terminalId "${terminalId}" until="ready".`
          : `Opened session ${terminalId} with ${name}.${shownNote} ${describeWait(terminalId, "ready", wait, agent)}`
      return reply(head + screenBlock(terminalId, wait.screen), {
        ...base,
        agent,
        cwd: cwd ?? "/workspace",
        ...waitData(wait, terminalId),
        status: wait.met ? "ready" : wait.reason === "timeout" ? "starting" : wait.reason,
      })
    }

    // Shell: honor cwd with real verification (audit 2026-10-18, T-005).
    const cwdResult = cwd
      ? await applyCwd(terminalId, cwd)
      : { cwdApplied: false, cwdError: null, startCursor: null }
    const cwdNote = cwd
      ? cwdResult.cwdApplied
        ? ` Working directory: ${cwd}.`
        : ` Could not cd into ${cwd}: ${cwdResult.cwdError}.`
      : ""
    const text =
      `Opened shell session ${terminalId}.${cwdNote}${shownNote} ` +
      `Next: terminal-run with terminalId "${terminalId}" to run commands.`
    return reply(text, {
      ...base,
      agent: null,
      cwd: cwd ?? null,
      cwdApplied: cwdResult.cwdApplied,
      cwdError: cwdResult.cwdError,
      startCursor: cwdResult.startCursor,
    })
  },
})

server.tool("terminal-prompt", {
  annotations: {
    readOnlyHint: false,
    safeWriteHint: true,
    summary: "Give a coding agent (Claude Code…) a prompt and wait for its turn to end",
    group: "Terminal",
  },
  description:
    "Send a prompt to the coding agent running in a session (Claude Code, Codex, opencode) and " +
    "wait until its turn ends: it finished (done), asks something / wants a permission " +
    "(blocked), shows its login screen, or left. Returns what happened and the screen with its " +
    "answer. Multi-line prompts are pasted as one message. If it is still working when the " +
    'wait runs out, call terminal-wait until="turn" — never send the prompt again. Also use ' +
    'it for slash commands ("/clear", "/exit") and to answer a free-text question.',
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session from terminal-create agent=…" },
      text: { type: "string", description: "The prompt (any length, newlines allowed)" },
      timeoutMs: {
        type: "number",
        description: `How long to wait for the turn to end (default ${PROMPT_WAIT_MS}, max ${MAX_STATE_WAIT_MS})`,
      },
    },
    required: ["terminalId", "text"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const text = requireString(args, "text")
    const started = Date.now()
    const woken = await wakeForUse(terminalId, 60_000)
    const { status, note } = woken
    // A wake from sleep spent part of this call's budget.
    const timeoutMs = Math.min(
      clampTimeout(args, "timeoutMs", PROMPT_WAIT_MS, MAX_STATE_WAIT_MS),
      Math.max(5_000, TOOL_BUDGET_MS - (Date.now() - started)),
    )
    const command = status.command ?? null
    if (!command || !AGENT_COMMANDS.has(command)) {
      throw new Error(
        `No coding agent is running in ${terminalId} (the foreground program is ${command ?? "the shell"}). ` +
          'Use terminal-run for shell commands, or open one with terminal-create agent="claude".',
      )
    }
    // Type it, let it land, and only then press Enter: an agent can open a
    // dialog at any moment (Claude Code's one-time offers), and an Enter sent
    // blindly would answer it instead of sending the prompt.
    const write = await backendAction<{ ok: boolean; pasted?: boolean }>("terminal.write", {
      terminalId,
      data: text,
      sendEnter: false,
      paste: "auto",
    })
    const typed = await waitState(terminalId, "quiet", TYPE_SETTLE_TIMEOUT_MS, {
      quietMs: TYPE_SETTLE_MS,
    })
    if (typed.question && !isOwnText(typed.question, text)) {
      const name = agentName(command)
      return reply(
        `${note}${name} is showing a question, so your prompt was typed but NOT sent: "${typed.question}". ` +
          "Answer it (terminal-send-key with the option the screen shows), then send the prompt " +
          'with terminal-send-key key="enter" and terminal-wait until="turn".' +
          screenBlock(terminalId, typed.screen),
        { ...waitData(typed, terminalId), reason: "blocked", message: typed.question, sent: false },
      )
    }
    // The Enter is the mark: only what happens after the submit ends the wait.
    await backendAction("terminal.write", { terminalId, data: "\r" })
    let wait = await waitState(terminalId, "turn", timeoutMs)
    // The agent's own prompt on screen ("…proceed with the refactor?") is not a question.
    if (wait.reason === "blocked" && wait.message && isOwnText(wait.message, text)) {
      wait = { ...wait, reason: "done", message: undefined, question: null }
    }
    return reply(
      `${note}${waitLead(wait)}${describeWait(terminalId, "turn", wait, command)}${screenBlock(terminalId, wait.screen)}`,
      {
        ...waitData(wait, terminalId),
        pasted: write.pasted ?? false,
        sent: true,
        woke: woken.woke,
      },
    )
  },
})

server.tool("terminal-wait", {
  annotations: {
    readOnlyHint: true,
    summary: "Wait for a coding agent's turn, a ready prompt, quiet output, text, or exit",
    group: "Terminal",
  },
  description:
    "Wait for something to happen in a session instead of sleeping or polling, then get the " +
    'screen. until: "turn" — the coding agent finished its turn, asks something, shows its ' +
    'login screen or left (after terminal-prompt / terminal-send-key); "ready" — a coding agent ' +
    'started and waits for a prompt; "exit" — the running shell command finished; "quiet" — ' +
    'no output for quietMs (any program settled); "text" — the screen shows `text` ' +
    "(case-insensitive) or matches the regex `pattern`. Only what happens after your last " +
    "write/prompt/key counts. A timeout is not an error: it says what is going on, and you " +
    "can call it again." +
    ' If a person switches the session to "Agent off" or starts typing in it, the wait stops early ' +
    '(reason "driver"): don\'t type until control is yours again.',
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      until: {
        type: "string",
        enum: ["turn", "ready", "exit", "quiet", "text"],
        description: "What to wait for (see the tool description)",
      },
      text: { type: "string", description: 'until="text": text the screen must show' },
      pattern: {
        type: "string",
        description: 'until="text": JavaScript regex matched against the whole screen',
      },
      quietMs: {
        type: "number",
        description: 'until="quiet": how long without output counts as settled (default 1500)',
      },
      timeoutMs: {
        type: "number",
        description: `Give up after this many ms (default 30000, max ${MAX_STATE_WAIT_MS})`,
      },
    },
    required: ["terminalId", "until"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const until = requireString(args, "until")
    const timeoutMs = clampTimeout(args, "timeoutMs", 30_000, MAX_STATE_WAIT_MS)
    const quietMs = optionalInt(args, "quietMs")
    const extra = {
      ...(typeof args.text === "string" && args.text ? { text: args.text } : {}),
      ...(typeof args.pattern === "string" && args.pattern ? { pattern: args.pattern } : {}),
      ...(quietMs !== undefined ? { quietMs } : {}),
    }
    const { note, woke } = await wakeForUse(terminalId)
    const wait = await waitState(terminalId, until, timeoutMs, extra)
    return reply(
      `${note}${waitLead(wait)}${describeWait(terminalId, until, wait)}${screenBlock(terminalId, wait.screen)}`,
      { ...waitData(wait, terminalId), woke },
    )
  },
})

server.tool("terminal-run", {
  annotations: {
    readOnlyHint: false,
    summary: "Run a shell command in a session and get its output",
    group: "Terminal",
  },
  description:
    "Run a command line in a shell session, wait for it to finish (up to timeoutMs) and return " +
    "its output. The user sees it run in that session's Terminal window. For long or interactive " +
    "programs it returns what they printed so far and that they are still running: then use " +
    'terminal-wait until="exit", terminal-screen, terminal-send-key (ctrl-c to stop). For a ' +
    "coding agent use terminal-prompt instead.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Shell session from terminal-create" },
      command: { type: "string", description: "The command line (newlines run several lines)" },
      timeoutMs: {
        type: "number",
        description: `How long to wait for it to finish (default 30000, max ${MAX_STATE_WAIT_MS})`,
      },
    },
    required: ["terminalId", "command"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const command = requireString(args, "command")
    const timeoutMs = clampTimeout(args, "timeoutMs", 30_000, MAX_STATE_WAIT_MS)
    const { status, note, woke } = await wakeForUse(terminalId)
    if (status.command && AGENT_COMMANDS.has(status.command)) {
      throw new Error(
        `${agentName(status.command)} is running in ${terminalId}: send it a prompt with terminal-prompt, ` +
          "or quit it first (terminal-prompt text=/exit).",
      )
    }
    const write = await backendAction<{ ok: boolean; cursor?: number }>("terminal.write", {
      terminalId,
      data: command,
      sendEnter: true,
      paste: "auto",
    })
    const wait = await waitState(terminalId, "exit", timeoutMs)
    const read = await backendAction<TerminalReadResult>("terminal.read", {
      terminalId,
      ...(write.cursor !== undefined ? { since: Math.max(0, write.cursor - 1) } : {}),
    })
    const output = commandOutput(read.output, command)
    const finished = wait.reason === "exited"
    const head = finished
      ? `Finished in ${(wait.waitedMs / 1000).toFixed(1)} s.`
      : wait.reason === "ended"
        ? "The session ended."
        : `Still running after ${(wait.waitedMs / 1000).toFixed(1)} s (${wait.command ?? "a program"} in the foreground). ` +
          'Next: terminal-wait until="exit", terminal-screen to look, or terminal-send-key ctrl-c to stop it.'
    const body = output.text
      ? `\n--- output ---\n${output.text}\n--- end of output ---`
      : "\n(no output)"
    return reply(note + head + body, {
      terminalId,
      woke,
      finished,
      reason: wait.reason,
      output: output.text,
      truncatedLines: output.dropped,
      cursor: read.cursor,
      command: wait.command,
    })
  },
})

server.tool("terminal-screen", {
  annotations: {
    readOnlyHint: true,
    summary: "Look at the terminal screen as the user sees it",
    group: "Terminal",
  },
  description:
    "The rendered screen of a session as plain text, as a person looking at it sees it, plus " +
    "what runs in it and the coding agent's state. Use it for full-screen programs (Claude " +
    "Code, vim, htop, menus, installers). onlyChanges returns just the rows that changed since " +
    "your last look (row numbers from 0).",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      onlyChanges: {
        type: "boolean",
        description: "Only the rows that changed since the last screen you got (default false)",
      },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const { note, woke } = await wakeForUse(terminalId)
    const [{ screen, question, driver, handedBack }, { status }] = await Promise.all([
      backendAction<{
        screen: RenderedScreen
        question?: string | null
        driver?: Driver
        handedBack?: HandedBack
      }>("terminal.screen", {
        terminalId,
      }),
      backendAction<{ status: SessionInfo }>("terminal.status", { terminalId }),
    ])
    const previous = lastScreens.get(terminalId)
    const changes = args.onlyChanges === true ? screenChanges(previous, screen.lines) : null
    const head =
      note +
      controlNote({ driver, handedBack }) +
      statusLine({
        terminalId,
        command: status.command,
        agentState: status.agentState,
        needsAuth: status.needsAuth,
        space: status.space,
      }) +
      (question ? `\nWaiting for an answer: ${question}` : "")
    let text: string
    if (changes !== null) {
      lastScreens.set(terminalId, screen.lines)
      text = changes
        ? `${head}\n--- changed rows ---\n${changes}\n--- end ---`
        : `${head}\nNothing changed since your last look.`
    } else {
      text = head + screenBlock(terminalId, screen)
    }
    return reply(text, {
      terminalId,
      screen: screenText(screen),
      changes,
      rows: screen.rows,
      cols: screen.cols,
      cursor: screen.cursor,
      title: screen.title,
      command: screen.command,
      fullScreenApp: screen.alternateScreen,
      agentState: status.agentState ?? null,
      needsAuth: status.needsAuth ?? null,
      question: question ?? null,
      driver: driver ?? null,
      handedBack: handedBack ?? null,
      woke,
    })
  },
})

server.tool("terminal-read", {
  annotations: {
    readOnlyHint: true,
    summary: "Read a session's output log (plain text, incremental)",
    group: "Terminal",
  },
  description:
    "Read the output log of a session (escape codes removed): the last `lines` lines (default " +
    "200) or, with `since`, only what came after that cursor — every answer ends with the " +
    "cursor to pass next time. Good for logs and command output; for full-screen programs " +
    "(Claude Code, vim) use terminal-screen instead, the log of a TUI is redraw fragments.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      lines: {
        type: "number",
        description: "Return at most this many trailing lines (default: 200)",
      },
      since: {
        type: "number",
        description: "Cursor from a previous read/run/wait-for: only output after it",
      },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const lines = optionalInt(args, "lines")
    const since = optionalInt(args, "since")

    const { note, woke } = await wakeForUse(terminalId)
    const result = await backendAction<TerminalReadResult>("terminal.read", {
      terminalId,
      ...(since !== undefined ? { since } : { lines: lines ?? DEFAULT_READ_LINES }),
    })
    const empty = result.output.length === 0
    const dropped = result.truncated && since !== undefined ? " (older output was dropped)" : ""
    const lead = note + controlNote(result)
    const text = empty
      ? `${lead}No new output. cursor=${result.cursor}`
      : `${lead}${renderCarriageReturns(result.output)}\n--- cursor=${result.cursor}${dropped} ---`
    return reply(text, {
      woke,
      driver: result.driver ?? null,
      handedBack: result.handedBack ?? null,
      output: result.output,
      cursor: result.cursor,
      truncated: result.truncated ?? false,
      empty,
    })
  },
})

server.tool("terminal-write", {
  annotations: {
    readOnlyHint: false,
    safeWriteHint: true,
    summary: "Type text into a terminal session",
    group: "Terminal",
  },
  description:
    "Type text into a session, then press Enter (sendEnter, default true). Low-level: prefer " +
    "terminal-run for shell commands and terminal-prompt for coding agents, which also wait " +
    "for the result. Multi-line text goes in as one paste when the program supports it. Use " +
    "sendEnter false to fill an input without submitting it.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      text: { type: "string", description: "Text to type" },
      sendEnter: {
        type: "boolean",
        description: "Press Enter after the text (default: true)",
        default: true,
      },
    },
    required: ["terminalId", "text"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const text = requireString(args, "text")
    const sendEnter = args.sendEnter !== false

    const { note, woke } = await wakeForUse(terminalId)
    const result = await backendAction<{ ok: boolean; cursor?: number; pasted?: boolean }>(
      "terminal.write",
      { terminalId, data: text, sendEnter, paste: "auto" },
    )
    const how = result.pasted ? "Pasted" : "Typed"
    return reply(
      `${note}${how} into ${terminalId}${sendEnter ? " and pressed Enter" : ""}. ` +
        'Next: terminal-wait (until="exit" for a command, "turn" for a coding agent, "quiet" for anything else).',
      { sent: true, sendEnter, cursor: result.cursor, pasted: result.pasted ?? false, woke },
    )
  },
})

server.tool("terminal-send-key", {
  annotations: {
    readOnlyHint: false,
    safeWriteHint: true,
    summary: "Press keys in a terminal session (enter, arrows, ctrl-c, escape…)",
    group: "Terminal",
  },
  description:
    "Press one key or a sequence of keys in a session: pick menu options (keys " +
    '["down","enter"]), answer a permission prompt ("1", "enter"), interrupt (ctrl-c), leave ' +
    "(ctrl-d), cancel (escape), cycle modes (shift-tab). Keys: " +
    KEY_HELP +
    ". Then terminal-wait to see the effect.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      key: { type: "string", description: "One key (see the description)" },
      keys: {
        type: "array",
        items: { type: "string" },
        description: 'Several keys pressed in order, e.g. ["down","down","enter"]',
      },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const list = Array.isArray(args.keys)
      ? args.keys.map((k) => String(k))
      : typeof args.key === "string" && args.key
        ? [args.key]
        : []
    if (list.length === 0) throw new Error("key or keys is required")
    if (list.length > 50) throw new Error("at most 50 keys per call")
    const sequence = list.map((k) => resolveKey(k)).join("")
    const { note, woke } = await wakeForUse(terminalId)
    await backendAction("terminal.input", { terminalId, data: sequence })
    return reply(
      `${note}Pressed ${list.join(", ")} in ${terminalId}. Next: terminal-wait to see the effect.`,
      {
        woke,
        sent: true,
        key: list.length === 1 ? list[0] : undefined,
        keys: list,
        sequence: showSequence(sequence),
      },
    )
  },
})

server.tool("terminal-wait-for", {
  annotations: {
    readOnlyHint: true,
    summary: "Wait until a session's output log matches a regex",
    group: "Terminal",
  },
  description:
    "Wait until a line of the session's output log matches a JavaScript regex (checked against " +
    "what is buffered, then every new line). By default only output after your last " +
    "terminal-write counts, so the echo of the command itself never matches. For screens of " +
    'full-screen programs and coding agents use terminal-wait (until="text" / "turn").',
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      pattern: {
        type: "string",
        description:
          'JavaScript regex to match against output lines (e.g. "\\$ $", "password:", "done")',
      },
      timeoutMs: {
        type: "number",
        description: `Give up after this many ms (default: ${DEFAULT_WAIT_TIMEOUT_MS}, max: ${MAX_STATE_WAIT_MS})`,
      },
      since: {
        type: "number",
        description: "Only consider output at or after this cursor (from read/run/wait-for)",
      },
    },
    required: ["terminalId", "pattern"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const pattern = requireString(args, "pattern")
    const timeoutMs = clampTimeout(args, "timeoutMs", DEFAULT_WAIT_TIMEOUT_MS, MAX_STATE_WAIT_MS)
    const since = optionalInt(args, "since")

    const { note, woke } = await wakeForUse(terminalId)
    // softTimeout: report matched=false instead of erroring on timeout; the
    // bridge timeout gets headroom so WAIT_TIMEOUT is never the transport error.
    const result = await backendAction<TerminalWaitForResult>(
      "terminal.waitFor",
      {
        terminalId,
        pattern,
        timeoutMs,
        softTimeout: true,
        ...(since !== undefined ? { fromLine: since } : {}),
      },
      timeoutMs + BRIDGE_HEADROOM_MS,
    )
    const text = result.matched
      ? `${note}Matched: ${result.line}\n--- cursor=${result.cursor} (pass as since to read what follows) ---`
      : `${note}No line matched /${pattern}/ within ${timeoutMs} ms. Look with terminal-screen or terminal-read.`
    return reply(text, {
      woke,
      matched: result.matched,
      output: result.line,
      lineIndex: result.lineIndex,
      cursor: result.cursor,
      timedOut: !result.matched,
    })
  },
})

server.tool("terminal-list", {
  annotations: {
    readOnlyHint: true,
    summary: "List the terminal sessions you can reach",
    group: "Terminal",
  },
  description:
    "List the terminal sessions you can reach in this workspace: the ones agents opened (the " +
    'workspace\'s members see those too) and the ones a person opened and switched to "Agent". A ' +
    "session a person opens, their personal terminal or a shared one, is not listed while it reads " +
    '"Agent off": to ' +
    'work in it, ask them to switch it to "Agent" in that session\'s Terminal window. Each line has ' +
    "the id, title, what runs in it, the coding agent's state (working / blocked = waiting for " +
    "someone / done), which space it is in (a person's personal terminal, or a shared one in the " +
    "workspace's machine), who opened it, who is typing, who is watching, and whether it is asleep " +
    "(idle sessions freeze, then sleep; any tool that uses one wakes it). Reuse a session instead " +
    "of opening a new one.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const result = await backendAction<{ sessions: SessionInfo[] }>("terminal.list")
    const sessions = result.sessions ?? []
    const lines = sessions.map((s) => sessionLine(s))
    const list = sessions.length
      ? `${sessions.length} session(s):\n${lines.join("\n")}`
      : 'No terminal sessions you can reach. Open one with terminal-create (agent="claude" for Claude Code).'
    return reply(list, { sessions, count: sessions.length })
  },
})

server.tool("terminal-request-control", {
  annotations: {
    readOnlyHint: false,
    safeWriteHint: true,
    summary: "Ask the person for control of a session",
    group: "Terminal",
  },
  description:
    "Ask for control of a session you can reach while a person is typing in it (your writes there " +
    'are refused with "<name> is typing in this session" until they have typed nothing for 60 s). ' +
    'The person gets "Allow" / "Keep off" in this chat and in that session\'s Terminal window; ' +
    '"Allow" switches it to "Agent" for you at once. Waits up to 90 s: granted (nobody was typing), ' +
    "approved (you may type), denied (don't type; say in chat what you need or open your own " +
    "session), pending (call again to keep waiting) or busy (another agent asked first; nothing " +
    'was sent). It cannot reach a person\'s own session that reads "Agent off": only they switch ' +
    "that on.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
      reason: {
        type: "string",
        description: 'What you want to do there, in a few words (e.g. "run the tests")',
      },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const reason = typeof args.reason === "string" && args.reason ? args.reason : undefined
    const r = await backendAction<{
      outcome: ControlOutcome
      driver?: Driver | null
      handedBack?: HandedBack
      answeredBy?: { id: string; name: string }
      askedBy?: { id: string; name: string }
    }>(
      "terminal.requestWheel",
      { terminalId, reason, timeoutMs: CONTROL_WAIT_MS },
      CONTROL_WAIT_MS + BRIDGE_HEADROOM_MS,
    )
    const by =
      r.askedBy?.name ?? r.answeredBy?.name ?? (r.driver?.kind === "human" ? r.driver.name : null)
    return reply(controlRequestText(r.outcome, terminalId, { by }), {
      terminalId,
      outcome: r.outcome,
      driver: r.driver ?? null,
    })
  },
})

server.tool("terminal-release-control", {
  annotations: {
    readOnlyHint: false,
    safeWriteHint: true,
    summary: "Let go of control of a session",
    group: "Terminal",
  },
  description:
    "Let go of a session you are typing in, when the person asks you to stop, let them type or " +
    'give them control. Then tell them how: they switch it to "Agent off" in that session\'s ' +
    "Terminal window and type (while an agent types, a person's keys are not sent). Don't type " +
    'there again until they switch it back to "Agent" (a note they leave comes with your next ' +
    "call) or you ask with terminal-request-control. Answers released, or who is typing when it " +
    "wasn't you (nothing changes).",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const r = await backendAction<{ released: boolean; driver?: Driver | null }>(
      "terminal.releaseWheel",
      { terminalId },
    )
    return reply(releaseControlText({ ...r, terminalId }), {
      terminalId,
      released: r.released,
      driver: r.driver ?? null,
    })
  },
})

server.tool("terminal-show", {
  annotations: {
    readOnlyHint: true,
    summary: "Open a session's Terminal window for the user",
    group: "Terminal",
  },
  description:
    "Open or focus a session's own Terminal window in the user's app (one window shows one " +
    "session), so they can watch what happens in it. terminal-create already does this unless " +
    "show=false.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    const r = await backendAction<{
      ok: boolean
      watchers?: Array<{ kind: string; name: string } | string>
    }>("terminal.reveal", {
      terminalId,
    })
    const names = (r.watchers ?? [])
      .filter((w) => typeof w === "string" || w.kind === "human")
      .map((w) => (typeof w === "string" ? w : w.name))
    const watching = names.length ? ` Watching it now: ${names.join(", ")}.` : ""
    return reply(
      `Asked the user's app to open or focus the Terminal window of ${terminalId}. With Teros closed, they ` +
        `find it later in the "Sessions" list of any Terminal window.${watching}`,
      { shown: true, terminalId, watchers: names },
    )
  },
})

server.tool("terminal-destroy", {
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    summary: "Close a terminal session",
    group: "Terminal",
  },
  description:
    'End a session and kill whatever runs in it (what "End session" in the window\'s ⋯ menu does; ' +
    "closing a window never ends its session). Only end sessions you opened, or that the user " +
    "asked you to end.",
  parameters: {
    type: "object",
    properties: {
      terminalId: { type: "string", description: "Session id" },
    },
    required: ["terminalId"],
  },
  handler: async (args) => {
    const terminalId = requireString(args, "terminalId")
    try {
      await backendAction("terminal.destroy", { terminalId })
      lastScreens.delete(terminalId)
      return reply(`Closed ${terminalId}.`, { destroyed: true, terminalId })
    } catch (error) {
      if (errorCode(error) === "FORBIDDEN_TERMINAL") throw error
      throw new Error(`terminal-destroy failed: ${errorMessage(error)}`)
    }
  },
})

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error("Failed to start MCA:", error)
  process.exit(1)
})
