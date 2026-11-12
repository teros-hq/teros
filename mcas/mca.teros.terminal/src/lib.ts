/**
 * mca.teros.terminal — backend bridge
 *
 * The terminal tools are a thin wrapper over the backend's PTY sessions
 * (PtyManager + terminal.* WsRouter actions in
 * packages/backend/src/handlers/domains/terminal). The backend does not expose
 * terminal.* actions over the MCA HTTP callback — the supported path for an
 * MCA is the admin_request bridge on the persistent WebSocket connection
 * (McaConnectionManager.handleAdminRequest → WsRouter.dispatch, with the app
 * owner's userId resolved for authz). The SDK's McaWebSocketClient.adminRequest()
 * implements the client side of that bridge.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { createWebSocketClient, type McaWebSocketClient } from "@teros/mca-sdk"

let wsClient: McaWebSocketClient | undefined
let wsConnected = false
let connecting: Promise<void> | undefined

export function isWsConnected(): boolean {
  return wsConnected
}

export function hasWsClient(): boolean {
  return wsClient !== undefined
}

/**
 * Create the WS client lazily — never at import time, so tools/list (e.g.
 * scripts/generate-mca-tools.ts, which runs without MCA_WS_URL) keeps working.
 * Throws when MCA_WS_URL is missing.
 */
export function getWsClient(): McaWebSocketClient {
  if (!wsClient) {
    wsClient = createWebSocketClient()
    wsClient.on("connected", () => {
      wsConnected = true
    })
    wsClient.on("disconnected", () => {
      wsConnected = false
    })
  }
  return wsClient
}

/** Connect (idempotent, concurrent-safe). adminRequest also tolerates a cold-start race. */
export async function connectWsClient(): Promise<void> {
  const client = getWsClient()
  if (wsConnected) return
  if (!connecting) {
    connecting = client
      .connect()
      .then(() => {
        wsConnected = true
      })
      .finally(() => {
        connecting = undefined
      })
  }
  await connecting
}

/** The Teros agent the current tool call serves (its seat in the user's Terminal window). */
const acting = new AsyncLocalStorage<string | undefined>()

/** Run a tool handler on behalf of this agent: its backend calls carry `agentId`. */
export function actingFor<T>(agentId: string | undefined, fn: () => T): T {
  return acting.run(agentId, fn)
}

/**
 * Call a backend WsRouter action via the admin_request bridge.
 * Handler errors arrive as Error with `.code` set to the HandlerError code
 * (e.g. TERMINAL_NOT_FOUND, FORBIDDEN_TERMINAL, WAIT_TIMEOUT, WHEEL_HELD).
 * Terminal calls say which agent they act for (the backend checks it against
 * the app's grants): its name and face go on the seat when it drives.
 */
export async function backendAction<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  await connectWsClient()
  const agentId = acting.getStore()
  const withAgent =
    agentId && action.startsWith("terminal.") && params.agentId === undefined
      ? { ...params, agentId }
      : params
  return getWsClient().adminRequest<T>(action, withAgent, timeoutMs)
}

/** Who holds the wheel of a session (terminal crew). */
export interface Driver {
  kind: "agent" | "human" | "none"
  id?: string
  name?: string
  since: number
  note?: string | null
}

/** A person's give-back note, delivered once. */
export interface HandedBack {
  by: { id: string; name: string }
  note: string | null
}

/**
 * What the agent must know about the wheel, as a lead sentence ("" when
 * nothing): a person gave it back (with their note — read the screen to see
 * what they did), or a person holds it now (don't type; wait or ask).
 */
export function wheelNote(r: { driver?: Driver | null; handedBack?: HandedBack | null }): string {
  if (r.handedBack) {
    const said = r.handedBack.note ? ` Their note: "${r.handedBack.note}".` : " They left no note."
    return `${r.handedBack.by.name} gave you the wheel back.${said} Look at the screen to see what they did before you go on.\n`
  }
  if (r.driver?.kind === "human") {
    return `${r.driver.name || "The user"} has the wheel (since ${clock(r.driver.since)}): don't type into this session; wait (terminal-wait returns when they give it back) or ask them in chat.\n`
  }
  return ""
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC"
}

/** Generate a fresh terminal session id (the backend treats terminalIds as capabilities). */
export function newTerminalId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `term_${Date.now().toString(36)}_${rand}`
}

/** Named keys for terminal-send-key (xterm sequences, what a real keyboard sends). */
export const KEY_SEQUENCES: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  escape: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
}

/** Spellings people and models use for the same key. */
const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  "page-up": "pageup",
  pgup: "pageup",
  "page-down": "pagedown",
  pgdn: "pagedown",
  del: "delete",
  bs: "backspace",
  "s-tab": "shift-tab",
  backtab: "shift-tab",
}

/** What terminal-send-key accepts, for descriptions and errors. */
export const KEY_HELP =
  "enter, tab, shift-tab, escape, backspace, delete, space, up, down, left, right, home, end, " +
  "pageup, pagedown, insert, f1–f12, ctrl-<letter> (ctrl-c, ctrl-d, ctrl-r…), alt-<key> " +
  "(alt-b, alt-enter…), or a single character"

/**
 * Resolve a key name to its byte sequence: named keys, ctrl-<letter>
 * (also "C-x", "^X"), alt-<key> (ESC prefix), single characters as
 * themselves. Unknown names are rejected: they would type garbage.
 */
export function resolveKey(key: string): string {
  if (key.length === 1) return key
  const k = key.trim().toLowerCase().replace(/\s+/g, "").replace(/\+/g, "-")
  const named = KEY_SEQUENCES[KEY_ALIASES[k] ?? k]
  if (named !== undefined) return named
  const ctrl = k.match(/^(?:ctrl-|control-|c-|\^)(.)$/)
  if (ctrl) {
    const c = ctrl[1]
    if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96)
    const special: Record<string, string> = {
      "@": "\x00",
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      _: "\x1f",
      " ": "\x00",
    }
    if (special[c]) return special[c]
  }
  const alt = key.trim().match(/^(?:alt|meta|m|option)[-+](.+)$/i)
  if (alt) return `\x1b${resolveKey(alt[1])}`
  throw new Error(`Unsupported key "${key}". Use: ${KEY_HELP}.`)
}

/** Printable rendering of a key sequence (\x03 for ctrl-c). */
export function showSequence(sequence: string): string {
  return Array.from(sequence)
    .map((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 0x20 && code < 0x7f ? ch : `\\x${code.toString(16).padStart(2, "0")}`
    })
    .join("")
}

// ── Screen text for agents ──────────────────────────────────────────────────

export interface RenderedScreen {
  cols: number
  rows: number
  lines: string[]
  cursor: { x: number; y: number; visible: boolean }
  title: string
  command: string
  alternateScreen: boolean
}

/**
 * The screen as compact text: trailing blank rows dropped (but never the
 * cursor's row), runs of blank rows collapsed to one, trailing spaces gone.
 */
export function screenText(screen: Pick<RenderedScreen, "lines" | "cursor">): string {
  const lines = screen.lines.map((l) => l.replace(/\s+$/, ""))
  let last = lines.length - 1
  while (last > screen.cursor.y && last >= 0 && lines[last] === "") last--
  const out: string[] = []
  for (const line of lines.slice(0, last + 1)) {
    if (line === "" && out[out.length - 1] === "") continue
    out.push(line)
  }
  while (out.length && out[0] === "") out.shift()
  return out.join("\n")
}

/** Rows that differ from the previous screen, as "NN│text" (row numbers from 0). */
export function screenChanges(previous: string[] | undefined, current: string[]): string | null {
  if (!previous) return null
  const changed: string[] = []
  const n = Math.max(previous.length, current.length)
  for (let i = 0; i < n; i++) {
    const a = (previous[i] ?? "").replace(/\s+$/, "")
    const b = (current[i] ?? "").replace(/\s+$/, "")
    if (a !== b) changed.push(`${String(i).padStart(2, " ")}│${b}`)
  }
  return changed.join("\n")
}

export interface AgentStateInfo {
  state: string
  message?: string
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  gemini: "Gemini CLI",
  aider: "aider",
}

export function agentName(command: string | null | undefined): string {
  return (command && AGENT_NAMES[command]) || command || "the program"
}

/** One status line: what runs in the session and its coding-agent state. */
export function statusLine(s: {
  terminalId: string
  command?: string | null
  agentState?: AgentStateInfo | null
  needsAuth?: string | null
}): string {
  const parts = [s.terminalId]
  if (s.command) parts.push(`running ${s.command}`)
  if (s.needsAuth) parts.push(`${agentName(s.needsAuth)} needs to sign in`)
  else if (s.agentState) {
    const msg = s.agentState.message ? ` (${s.agentState.message})` : ""
    parts.push(`agent ${s.agentState.state}${msg}`)
  }
  return parts.join(" · ")
}

/** The person's coding-agent sign-in as an agent may know it (backend `agentAuth`): never the secret. */
export interface AgentAuthInfo {
  agent: string
  signedIn: boolean
  mode: "teros" | "subscription" | "apiKey" | null
  /** Shared with this workspace's agents: only then do sessions an agent opens get it. */
  shared: boolean
}

const AUTH_MODES: Record<string, string> = {
  subscription: "Claude account (Pro/Max subscription)",
  apiKey: "API key",
  teros: "Teros provider",
}

/**
 * One sentence on whether the sessions an agent opens get the person's
 * sign-in, and the next step when they don't ("" when unknown).
 */
export function agentAuthNote(a: AgentAuthInfo | null | undefined): string {
  if (!a) return ""
  const name = agentName(a.agent)
  const never = "Never ask for or type the credential itself."
  if (a.signedIn && a.shared) {
    return `${name} signs in with the user's own ${AUTH_MODES[a.mode ?? ""] ?? "sign-in"}, shared with this workspace's agents.`
  }
  if (a.signedIn) {
    return `The user has a ${name} sign-in but has not shared it with this workspace's agents, so your ${name} sessions open without it. Next: ask them to turn on "Share with this workspace's agents" in their Terminal window (a ${name} session's menu → "${name} sign-in"). ${never}`
  }
  return `The user has no ${name} sign-in in Teros yet, so your ${name} sessions open without it. Next: ask them to open their Terminal window → new session → ${name}, pick ${a.agent === "claude" ? "Sign in with Claude (Pro/Max), API key or Use Teros" : "how it signs in"}, and leave "Share with this workspace's agents" on. ${never}`
}

/** Wrap a text answer for the LLM plus the same data for scripts. */
export function reply(text: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: data }
}

// ── Sleep: sessions freeze and sleep when idle, and wake on use ─────────────

/** A session woken from sleep: what came back (backend SessionInfo.resumed). */
export interface ResumeInfo {
  agent: string | null
  notRestored: string | null
  message: string
}

/** The sentence a tool's answer starts with when it had to wake the session ("" when it was awake). */
export function wokeNote(woke: string | null | undefined, resumed?: ResumeInfo | null): string {
  if (woke === "frozen") return "The session was frozen (idle); it was woken first. "
  if (woke !== "sleeping") return ""
  const what = resumed?.message ?? "Resumed after sleep."
  return (
    "The session was asleep; it was woken first (a fresh machine in the same directory: its old " +
    `output is printed above the "resumed after sleep" line). ${what} `
  )
}

/** How terminal-list describes a frozen or sleeping session ("" for an awake one). */
export function lifecycleLabel(
  s: { lifecycle?: string | null; sleptAt?: string | null },
  now = Date.now(),
): string {
  if (s.lifecycle === "frozen") return "frozen (idle; wakes when used)"
  if (s.lifecycle !== "sleeping") return ""
  const since = s.sleptAt ? Date.parse(s.sleptAt) : Number.NaN
  if (!Number.isFinite(since)) return "asleep (wakes when used)"
  const mins = Math.max(1, Math.round((now - since) / 60_000))
  const ago =
    mins < 120
      ? `${mins} min`
      : mins < 2880
        ? `${Math.round(mins / 60)} h`
        : `${Math.round(mins / 1440)} days`
  return `asleep for ${ago} (wakes when used)`
}

// ── Shell command output ────────────────────────────────────────────────────

/** Foreground commands that are coding agents (as the backend's agent-heuristics). */
export const AGENT_COMMANDS = new Set([
  "claude",
  "opencode",
  "aider",
  "codex",
  "gemini",
  "goose",
  "crush",
  "amp",
  "cursor-agent",
  "qwen",
  "droid",
  "kimi",
])

/** A shell prompt line (bash's `user@host:dir# `, `$ `, zsh's `% `). */
const PROMPT_LINE = /[$#%>❯]\s*$/

const MAX_RUN_OUTPUT_LINES = 300

/**
 * A command's own output out of the log: drop the echoed command line(s) at
 * the top and the shell prompt it ended on; keep at most the last
 * MAX_RUN_OUTPUT_LINES lines.
 */
export function commandOutput(output: string, command: string): { text: string; dropped: number } {
  const lines = renderCarriageReturns(output).split("\n")
  const first = command.split("\n")[0].trim()
  const echo = lines.findIndex((l) => first && l.includes(first))
  let body = echo === -1 || echo > 2 ? lines : lines.slice(echo + command.split("\n").length)
  // Trailing prompt and blank lines.
  while (
    body.length &&
    (body[body.length - 1].trim() === "" || PROMPT_LINE.test(body[body.length - 1]))
  )
    body = body.slice(0, -1)
  const dropped = Math.max(0, body.length - MAX_RUN_OUTPUT_LINES)
  const kept = dropped ? body.slice(-MAX_RUN_OUTPUT_LINES) : body
  return {
    text: (dropped ? `[${dropped} earlier lines not shown]\n` : "") + kept.join("\n"),
    dropped,
  }
}

/**
 * What a terminal shows for lines with bare carriage returns: each "\r"
 * returns to column 0 and what follows overwrites (progress bars, spinners,
 * bash's "\r" after its paste-mode switch). The log keeps them raw.
 */
export function renderCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const cells: string[] = []
      for (const part of line.split("\r")) {
        const chars = Array.from(part)
        for (let i = 0; i < chars.length; i++) cells[i] = chars[i]
      }
      return cells.join("")
    })
    .join("\n")
}

// ── Telling the agent's own words from a question on screen ────────────────

const norm = (t: string) => t.replace(/[❯›>]/g, " ").replace(/\s+/g, " ").trim().toLowerCase()

/**
 * A "question" found on screen that is only the prompt the agent typed (its
 * echo in the input box or the transcript: "Do you want to proceed with the
 * refactor?") is not the coding agent asking anything. True when every part
 * of the detected question ("hook words — screen question (selected: …)")
 * appears in the text that was sent.
 */
export function isOwnText(question: string, sent: string): boolean {
  const haystack = norm(sent)
  const parts = question
    .split(/ — | · |\(selected: |\)$/)
    .map(norm)
    .filter((p) => p.length >= 4)
  return parts.length > 0 && parts.every((p) => haystack.includes(p))
}
