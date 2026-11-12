/**
 * PtyManager — manages PTY sessions for the Terminal window
 *
 * Three modes:
 *   - Terminal host (default for workspaces): the session is a window of the
 *             workspace's tmux server, in a long-lived `teros-term-*` container
 *             (services/terminal/term-host.ts). It survives the browser tab
 *             and the backend; the backend holds no process per session, only
 *             one tmux control client per workspace. tmux's grid is the
 *             server-side screen (snapshot(), screen()).
 *   - Docker (legacy fallback, images without tmux): bash inside the MCA bash
 *             container via `docker exec -it`, one backend process per session
 *   - Host:   runs bash directly on the host via node-pty. Legacy path —
 *             creation was removed with mca.teros.admin.bash (2026-10-19,
 *             replaced by Teros Remote); the manager still tracks live host
 *             sessions so the terminal domain can fail closed on them.
 *
 * Both enable full interactive terminal support: vim, htop, tab completion, etc.
 *
 * Sessions also carry the state needed to serve programmatic consumers (e.g. a
 * future PTY MCA driving a shell as an agent):
 *   - Circular output buffer per session (last MAX_BUFFER_LINES lines /
 *     MAX_BUFFER_BYTES bytes, whichever cap is hit first)
 *   - read()    → replay buffered output, ANSI-stripped, by tail lines or cursor
 *   - waitFor() → await a regex match on the output, with timeout
 *   - list()/getStatus() → session introspection
 *
 * Lifecycle — sessions never die on their own, they sleep. Only an explicit
 * end (destroy) or the process exiting removes one:
 *   awake    → frozen    when every session of a terminal host has been idle
 *                         for FREEZE_AFTER: `docker pause` of the host (no CPU,
 *                         memory kept, back in well under a second, nothing lost)
 *   frozen   → sleeping  after HIBERNATE_AFTER frozen: each session is saved
 *                         (scrollback, cwd, title, what ran, Claude Code's
 *                         session id) through the SleepStore, then the host
 *                         container is removed. Sleeping sessions stay listed.
 *   frozen / sleeping → awake on use: ensureAwake() (a viewer attaching, an
 *                         agent's tool call, input). Waking from sleep is the
 *                         terminal domain's SessionWaker: new host, same
 *                         terminalId and cwd, the old scrollback printed dimmed,
 *                         Claude Code resumed on its conversation.
 * Idle = no input, no output, no viewer, nobody waiting on it. Passive
 * observation (list/getStatus) deliberately is NOT activity — polling must
 * not keep a machine running.
 */

import { execSync } from "child_process"
import * as pty from "node-pty"
import type {
  TerminalConflict,
  TerminalDriver,
  TerminalHandedBack,
  TerminalWatcher,
} from "@teros/shared"
import type { PubSubService } from "./pubsub-service"
import {
  type CrewIdentity,
  DriverLease,
  type DriverLeaseOptions,
  type LeaseChange,
  parseLeaseSnapshot,
  type WheelHeld,
} from "./terminal/driver-lease"
import {
  AGENT_COMMANDS,
  detectBlocked,
  detectLoginScreen,
  detectMenu,
  type HeuristicState,
  nextHeuristicState,
} from "./terminal/agent-heuristics"
import { bracketedPasteChange, type RenderedScreen, replaceControls } from "./terminal/snapshot"
import type { TermHost, TermHostManager, TermWindow, TermWindowMeta } from "./terminal/term-host"

// ── Tunables ─────────────────────────────────────────────────────────────────

/** A terminal host whose sessions have all been idle this long is frozen (TERMINAL_FREEZE_AFTER_MS). */
export const FREEZE_AFTER_MS = 15 * 60 * 1000

/** A host frozen this long is hibernated: sessions saved, container removed (TERMINAL_HIBERNATE_AFTER_MS). */
export const HIBERNATE_AFTER_MS = 2 * 60 * 60 * 1000

/** Scrollback a sleeping session keeps (lines, then bytes from the top). */
export const SLEEP_HISTORY_LINES = 5000
const SLEEP_HISTORY_BYTES = 256 * 1024

/** Circular buffer cap: keep at most this many lines... */
export const MAX_BUFFER_LINES = 5000

/** ...or this many bytes, whichever limit is hit first. */
export const MAX_BUFFER_BYTES = 256 * 1024

/** Default line count for read() when neither `lines` nor `fromLine` is given. */
const DEFAULT_READ_LINES = 1000

/** Default timeout for waitFor(). */
const DEFAULT_WAIT_TIMEOUT_MS = 10_000

/** containerId recorded for host-mode sessions (createHost). */
export const HOST_CONTAINER_ID = "host"

/** Scrollback lines a viewer snapshot carries (the xterm.js scrollback is the same size). */
export const SNAPSHOT_HISTORY_LINES = 5000

/** Lines of tmux history an adopted session's read buffer is seeded with after a backend restart. */
const ADOPT_SEED_LINES = 1000

/** Sustained output above this (bytes/s) puts a session in flood mode. */
const FLOOD_BYTES_PER_SEC = 2 * 1024 * 1024

/** How often agent sessions without hooks are checked for a state change. */
const HEURISTIC_TICK_MS = 1500

/** A terminal host with no session left is removed after this long (its container stops costing anything). */
const HOST_IDLE_MS = 10 * 60 * 1000

/** Env vars a host shell inherits; everything else (DB URLs, API keys, signing secrets) is dropped. */
const HOST_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR"]

/**
 * Environment for a host PTY: the allowlist above plus LC_* locale vars.
 * The backend's own env carries every production secret; a host shell must not
 * get them for free with `env`. This is defence in depth only — the shell runs
 * as the backend's OS user and can still read whatever files that user can.
 */
export function hostPtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (HOST_ENV_ALLOWLIST.includes(key) || key.startsWith("LC_")) out[key] = value
  }
  out.TERM = "xterm-256color"
  return out
}

// ── Public types ─────────────────────────────────────────────────────────────

/** The slice of node-pty's IPty the manager uses — also implemented by tmux panes. */
export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number }) => void): unknown
}

/**
 * Coding-agent state of a session (herdr's vocabulary): `blocked` needs the
 * user (permission prompt, question), `done` finished its turn and waits for
 * the next prompt, `working` is busy, `idle` is a quiet agent. Reported by the
 * agent's own hooks (teros-agent-state) or inferred from the screen.
 */
export type AgentStateName = "working" | "blocked" | "done" | "idle"

export interface AgentState {
  state: AgentStateName
  /** Why (e.g. "Claude needs your permission to use Bash"), when the agent said. */
  message?: string
  at: Date
  source: "hook" | "heuristic"
}

/** Labels of a session. */
export interface SessionMeta {
  /** Deprecated and ignored: every session is kept until it is closed (it sleeps when idle). */
  pinned?: boolean
  title: string
  /** shell | claude | codex | agent … */
  kind: string
  /** userId of the creator, or `agent:<appId>` for agent-created sessions. */
  createdBy: string
  /** Bash app the session runs in (terminal-host sessions). */
  appId?: string
  /** How a coding agent in it signs in (chip text: "via Teros", "API key ····abcd"), never a secret. */
  auth?: string
}

export interface PtySession {
  terminalId: string
  ptyProcess: PtyLike
  /** Container name (docker mode) or 'host' (stdio mode) */
  containerId: string
  createdAt: Date
  /** Workspace that owns this PTY (from the app that spawned it) — used for authz */
  ownerWorkspaceId?: string
}

/**
 * Where a session is in its life: running, frozen with its host (docker
 * pause), or saved and asleep (no container). Frozen and sleeping sessions
 * wake on use.
 */
export type Lifecycle = "awake" | "frozen" | "sleeping"

/** A session saved to sleep (SleepStore): everything needed to bring it back. */
export interface SleepRecord {
  terminalId: string
  /** Backend stack (TermHostManager.stackId): two stacks on one Mongo never wake each other's sessions. */
  stackId: string
  workspaceId: string
  appId: string
  title: string
  kind: string
  createdBy: string
  createdAt: Date
  /** Chip text of the coding agent's sign-in ("API key ····abcd"), never a secret. */
  auth: string
  cwd: string
  cols: number
  rows: number
  /** Scrollback and screen as plain text, bounded (SLEEP_HISTORY_LINES / bytes). */
  history: string
  /** Foreground command when it fell asleep (bash, claude, node…). */
  command: string
  /** Its command line when it was not the shell (e.g. "npm run dev"), "" otherwise. */
  foreground: string
  /** Claude Code's session id (reported by its hooks), for `claude --resume`. */
  agentSession: string
  sleptAt: Date
  /** Who had the wheel (DriverLease snapshot, JSON): the driver survives the sleep. */
  lease?: string
}

/** Where sleeping sessions are kept (Mongo in production: services/terminal/sleep-store.ts). */
export interface SleepStore {
  load(stackId: string): Promise<SleepRecord[]>
  save(record: SleepRecord): Promise<void>
  remove(terminalId: string): Promise<void>
  rename(terminalId: string, title: string): Promise<void>
  /** Keep the driver of a sleeping session (DriverLease snapshot, JSON). */
  setLease?(terminalId: string, lease: string): Promise<void>
}

/**
 * Brings a sleeping session back: a host, the credentials, the preset — the
 * terminal domain's job. It ends with createInHost(…, { resumed }) on the same
 * terminalId, which revives the session in place.
 */
export type SessionWaker = (record: SleepRecord, by: { userId: string }) => Promise<void>

/** What a wake did. */
export interface WakeResult {
  from: "frozen" | "sleeping"
  ms: number
}

/** A session woken from sleep: what came back and what did not. */
export interface ResumeInfo {
  sleptAt: Date
  at: Date
  /** The coding agent restarted in it (claude: on its conversation), null for none. */
  agent: string | null
  /** What ran when it fell asleep and was not restarted (e.g. "npm run dev"), null for nothing. */
  notRestored: string | null
  /** One sentence for people and agents. */
  message: string
}

/** Lifecycle tunables (tests use small values). */
export interface PtyManagerOptions {
  freezeAfterMs?: number
  hibernateAfterMs?: number
  /** Driver lease windows (idle takeover, conflict). */
  lease?: DriverLeaseOptions
}

/** Counters for logs and metrics. */
export interface LifecycleStats {
  sessions: Record<Lifecycle, number>
  hosts: { awake: number; frozen: number }
  freezes: number
  hibernations: number
  wakes: Record<
    "frozen" | "sleeping",
    { count: number; lastMs: number; maxMs: number; totalMs: number }
  >
}

/** Internal per-session bookkeeping (buffer, waiters, lifecycle). Not part of the public surface. */
interface SessionRuntime {
  /** Circular buffer of raw (pre-strip) output lines. */
  buffer: string[]
  /** Absolute index of buffer[0] in the session's line sequence; > 0 once old lines were dropped. */
  bufferStartLine: number
  /** Approximate size of the retained buffer in bytes. */
  bufferBytes: number
  /** Last time the PTY produced output, if it ever did. */
  lastOutputAt: Date | null
  /** Last interaction (write/read/waitFor/resize/output) — drives freezing. */
  lastActivity: Date
  /** Pending waitFor() listeners, checked on every output chunk. */
  waiters: Set<WaitListener>
  /**
   * Cursor (absolute line index) captured at the last programmatic write().
   * waitFor() without an explicit fromLine starts here instead of at the
   * start of the buffer, so the TTY echo of the command just written (and
   * any older output) can never produce an instant false positive.
   */
  lastWriteNextLine: number
  meta: SessionMeta
  /** Terminal-host sessions: the host and the tmux window/pane. */
  tmux?: { host: TermHost; windowId: string; paneId: string }
  /** Current size (as last set). */
  cols: number
  rows: number
  agentState: AgentState | null
  /** Foreground command in the pane (terminal-host sessions, from tmux). */
  command: string | null
  /** Claude Code's own session id from `@agent_session` (CCR-REQ-8) — the --resume key, "" until the hook reports it. */
  agentSession: string
  /** DECSET 2004 as last seen in the output (tmux has no format for it). */
  bracketedPaste: boolean
  /** Raw output listeners (live viewers on /ws/terminal), called with the chunk's sequence number. */
  outputListeners: Set<(data: string, seq: number) => void>
  /** Output chunks seen so far — orders live output against snapshots. */
  outputSeq: number
  /** Last input: who typed (human userId or agent) and when. */
  lastInput: InputActor | null
  /** Foreground command when an agent hook last reported: hooks beat the screen heuristic for it. */
  hookAgent: string | null
  /** Coding agent on its login screen (window shows the sign-in card), null otherwise. */
  needsAuth: string | null
  /** lastOutputAt the heuristic last looked at (nothing new → no capture). */
  heuristicSeenOutput: number
  /** Output rate window (flood detection). */
  rateBytes: number
  rateStart: number
  /** Flood mode: the pane's output is off for the backend; viewers get snapshots. */
  flood: { since: number; timer: ReturnType<typeof setInterval>; lastActivity: number } | null
  /** Bumped on every agent-state change: waits tell a new state from the one they started with. */
  stateSeq: number
  /** Where the last programmatic write left the session (default start of waitUntil-based waits). */
  lastWriteMark: InputMark
  /** waitUntil() callers to wake on the next output chunk or change. */
  wakers: Set<() => void>
  /** Saved and asleep (no process, no container): what wakes it. */
  sleep: SleepRecord | null
  /** Woken from sleep: what came back. */
  resumed: ResumeInfo | null
  /** Who drives (agent / person / nobody), who typed, conflicts. */
  lease: DriverLease
  /** Agents waiting on the session right now (terminal.wait), by agent id. */
  agentWatchers: Map<string, { who: CrewIdentity; count: number }>
  /** Ends an unresolved conflict (DriverLease.expire). */
  conflictTimer: ReturnType<typeof setTimeout> | null
}

/** A point in a session's life: when, and which agent state was current (see waitUntil). */
export interface InputMark {
  at: number
  stateSeq: number
}

/** What a waitUntil() check sees of a session. */
export interface WaitView {
  /** The session is gone (exited, destroyed, host lost). */
  ended: boolean
  command: string | null
  agentState: AgentState | null
  stateSeq: number
  needsAuth: string | null
  /** ms epoch of the last output chunk, 0 if none. */
  lastOutputAt: number
  /** Output chunks seen so far (changes whenever the screen may have changed). */
  outputSeq: number
  /** Rendered screen (captured on demand; null for an ended session). */
  screen: () => Promise<RenderedScreen | null>
}

/** Who typed into a session last (shown to everyone watching it). */
export interface InputActor {
  kind: "human" | "agent"
  /** userId, or `agent:<appId>`. */
  id: string
  name?: string
  at: number
}

/** A session as stored by the manager: public shape + runtime bookkeeping. */
type ManagedSession = PtySession & SessionRuntime

/** Options for read(). */
export interface ReadOptions {
  /** Return at most this many trailing lines. Ignored when `fromLine` is set. Default: 1000. */
  lines?: number
  /** Cursor: return only lines at or after this absolute buffer index (e.g. `nextLine` from a previous read()/waitFor()). */
  fromLine?: number
  /** Return raw output including ANSI escape codes (default: stripped). */
  raw?: boolean
}

/** Result of read(). */
export interface ReadResult {
  /** Output lines (ANSI-stripped unless `raw: true`). */
  lines: string[]
  /** Absolute index of the first returned line. */
  fromLine: number
  /** Exclusive cursor: everything up to here is returned; pass as ReadOptions.fromLine to read only newer output. */
  nextLine: number
  /** True when older output was dropped by the circular buffer and is no longer retrievable. */
  truncated: boolean
  /** True when the session does not exist (lines is empty in that case). */
  notFound?: boolean
}

/** Options for waitFor(). */
export interface WaitForOptions {
  /** Reject with a timeout error after this many ms. Default: 10_000. */
  timeoutMs?: number
  /** Only consider output at or after this absolute buffer line index. Default: start of the retained buffer. */
  fromLine?: number
  /** Test against raw output including ANSI codes (default: stripped). */
  raw?: boolean
}

/** Result of waitFor(). */
export interface WaitForResult {
  matched: boolean
  /** The matching line (ANSI-stripped unless `raw: true`). */
  line: string
  /** Absolute buffer index of the matching line. */
  lineIndex: number
  /** Cursor just past the match — pass as fromLine to find the next match or read what follows. */
  nextLine: number
}

/** Public snapshot of a live session (list()). */
export interface SessionInfo {
  terminalId: string
  /** Container name (docker mode) or 'host' (stdio mode). */
  containerId: string
  createdAt: Date
  lastActivity: Date
  alive: boolean
  /** Lines currently retained in the circular buffer. */
  bufferSize: number
  ownerWorkspaceId?: string
  /** Deprecated, always true: sessions are kept until closed. */
  pinned: boolean
  /** awake, frozen (host paused) or sleeping (saved, no container): frozen and sleeping wake on use. */
  lifecycle: Lifecycle
  /** When it fell asleep (sleeping only). */
  sleptAt: Date | null
  /** Woken from sleep: what was restored and what not. */
  resumed: ResumeInfo | null
  title: string
  kind: string
  createdBy: string
  cols: number
  rows: number
  /** Foreground command (terminal-host sessions), e.g. bash, claude, vim. */
  command: string | null
  agentState: AgentState | null
  /** Claude Code's own session id (CCR-REQ-8) — the --resume key, "" when none. */
  agentSession: string
  /** True for sessions living in a terminal host (they survive backend restarts). */
  persistent: boolean
  /** How a coding agent in it signs in (chip text), "" for none. */
  auth: string
  /** A coding agent in it shows its login screen (e.g. "claude"): the window offers sign-in. */
  needsAuth: string | null
  /** Who typed last (a person or an agent) and when — the window follows the agent with it. */
  lastInput: InputActor | null
  /** Who holds the wheel (terminal crew). */
  driver: TerminalDriver
  /** Two people typing at once, null otherwise. */
  conflict: TerminalConflict | null
}

/** Detailed status for one session (getStatus()). */
export interface SessionStatus extends SessionInfo {
  /** Absolute index of the oldest retained buffer line (0 if nothing was dropped). */
  bufferStartLine: number
  /** Absolute index just past the newest buffered line (cursor for the next read). */
  bufferNextLine: number
  /** Approximate buffered bytes. */
  bufferBytes: number
  /** Last time the PTY produced output, if it ever did. */
  lastOutputAt: Date | null
  /** Best-effort foreground process inside the PTY (via ps), null when unavailable. */
  foregroundProcess: string | null
}

/** Internal waitFor() listener entry. */
interface WaitListener {
  regex: RegExp
  fromLine: number
  raw: boolean
  resolve: (result: WaitForResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ── ANSI stripping ───────────────────────────────────────────────────────────

/*
 * Self-contained ANSI/VT escape stripper (equivalent to the `strip-ansi`
 * package, which is present in node_modules but not declared as a backend
 * dependency — inlining avoids lockfile churn for one regex).
 *
 * Alternatives, in order:
 *   1. OSC (BEL-terminated):  ESC ] <params> BEL   — window titles, hyperlinks
 *   2. OSC (ST-terminated):   ESC ] <params> ESC \ *   3. CSI + short escapes:   ESC [ <params> <final-byte> (colors, cursor
 *      moves, private modes; colon sub-params like 38:5:196), also ESC ( B,
 *      ESC # 8, ESC M via the shared prefix class
 *   4. C1 intros (0x9D OSC, 0x90 DCS, 0x98/0x9E/0x9F SOS/PM/APC)
 *   5. Stray control chars (NUL, BEL, ...) left over from CR handling
 *
 * OSC alternatives come FIRST and match params permissively (anything but
 * BEL/ESC): titles routinely contain spaces and symbols. The strict
 * strip-ansi v7 pattern fails those (leaves `y title\u0007` garbage behind);
 * this one consumes the whole sequence. CSI is a separate alternative so its
 * final-byte class can never bite into an OSC prefix.
 */
const ANSI_PATTERN =
  [
    // 1+2: OSC — params are permissive (anything but BEL/ESC/C1-CSI)
    "[\\u001B\\u009B]\\][^\\u0007\\u001B\\u009B]*\\u0007",
    "[\\u001B]\\][^\\u0007\\u001B\\u009B]*\\u001B\\\\",
    // 3: CSI + short escapes sharing the prefix class
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])",
  ].join("|") +
  "|[\\u001B\\u009D\\u0090\\u0098\\u009E\\u009F].*?(?:\\u0007|\\u001B\\\\)" +
  "|[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]"

const ANSI_RE = new RegExp(ANSI_PATTERN, "g")

/** Remove ANSI escape codes (colors, cursor moves, OSC titles, etc.) from terminal output. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "")
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// ── Manager ──────────────────────────────────────────────────────────────────

export class PtyManager {
  private sessions = new Map<string, ManagedSession>()

  /** Partial line carried between onData chunks, keyed by terminalId. */
  private linePending = new Map<string, string>()

  /** Interval handle for the lifecycle sweep (freeze, hibernate, empty hosts). */
  private sweepTimer: ReturnType<typeof setInterval>

  readonly freezeAfterMs: number
  readonly hibernateAfterMs: number
  private readonly leaseOptions: DriverLeaseOptions

  /** Where sleeping sessions are saved; null: sessions are frozen but never hibernated. */
  private sleepStore: SleepStore | null = null

  /** Brings sleeping sessions back (the terminal domain). */
  private waker: SessionWaker | null = null

  /** Wakes in flight, by terminalId (a viewer and an agent arriving together wake it once). */
  private waking = new Map<string, Promise<WakeResult | null>>()

  /** Hosts being started for a wake (not idle, not empty): appId → wakes in flight. */
  private wakingHosts = new Map<string, number>()

  /** Hibernations in flight, by appId. */
  private hibernating = new Map<string, Promise<void>>()

  /** Freezes in flight, by appId. */
  private freezing = new Set<string>()

  /** Since when a host adopted frozen (backend restart) had been frozen, by appId: its clock goes on. */
  private frozenBefore = new Map<string, number>()

  private counters = {
    freezes: 0,
    hibernations: 0,
    wakes: {
      frozen: { count: 0, lastMs: 0, maxMs: 0, totalMs: 0 },
      sleeping: { count: 0, lastMs: 0, maxMs: 0, totalMs: 0 },
    },
  }

  /** Interval handle for the agent-state screen heuristic. */
  private heuristicTimer: ReturnType<typeof setInterval>
  private heuristicRunning = false

  /** Terminal hosts (tmux per workspace). Null when the backend runs without Docker terminals. */
  private termHosts: TermHostManager | null = null

  /** Since when each terminal host has had no session (idle removal). */
  private hostEmptySince = new Map<string, number>()

  /** Resolves once sessions of running terminal hosts have been adopted (backend boot). */
  private adopted: Promise<void> = Promise.resolve()

  /** Session list/state change listener (terminal domain → workspace topic). */
  private changeListener:
    | ((terminalId: string, workspaceId: string | undefined, reason: string) => void)
    | null = null

  constructor(
    private pubSubService: PubSubService,
    options: PtyManagerOptions = {},
  ) {
    this.freezeAfterMs =
      options.freezeAfterMs ?? (Number(process.env.TERMINAL_FREEZE_AFTER_MS) || FREEZE_AFTER_MS)
    this.hibernateAfterMs =
      options.hibernateAfterMs ??
      (Number(process.env.TERMINAL_HIBERNATE_AFTER_MS) || HIBERNATE_AFTER_MS)
    this.leaseOptions = options.lease ?? {}
    // Cheap (date math); often enough that a host freezes within a quarter of FREEZE_AFTER.
    const sweepMs = Math.min(60_000, Math.max(1000, Math.floor(this.freezeAfterMs / 4)))
    this.sweepTimer = setInterval(() => this._lifecycleSweep(), sweepMs)
    // Don't hold the process open just for the sweep.
    this.sweepTimer.unref?.()
    this.heuristicTimer = setInterval(() => void this._heuristicTick(), HEURISTIC_TICK_MS)
    this.heuristicTimer.unref?.()
  }

  // ── Terminal hosts (tmux) ──────────────────────────────────────────────────

  /** Enable terminal-host sessions. Called once at boot with the host manager. */
  useTermHosts(manager: TermHostManager): void {
    this.termHosts = manager
  }

  get termHostManager(): TermHostManager | null {
    return this.termHosts
  }

  /** Save sleeping sessions here (and load the ones saved before this boot). */
  useSleepStore(store: SleepStore): void {
    this.sleepStore = store
    this.adopted = this.adopted.then(() => this._loadSleeping())
  }

  /** Who brings a sleeping session back (the terminal domain). */
  useWaker(waker: SessionWaker): void {
    this.waker = waker
  }

  /** Notified on session create/exit/rename/agent-state/lifecycle changes. */
  onChange(
    listener: (terminalId: string, workspaceId: string | undefined, reason: string) => void,
  ): void {
    this.changeListener = listener
  }

  private _changed(
    session: { terminalId: string; ownerWorkspaceId?: string },
    reason: string,
  ): void {
    this._wake(this.sessions.get(session.terminalId))
    try {
      this.changeListener?.(session.terminalId, session.ownerWorkspaceId, reason)
    } catch (err) {
      console.warn(`[PtyManager] change listener failed: ${String(err)}`)
    }
  }

  /** Resolves when boot-time adoption of running terminal hosts has finished. */
  whenAdopted(): Promise<void> {
    return this.adopted
  }

  /**
   * Re-attach to every terminal host of this stack that survived a backend
   * restart and register its sessions (state comes from tmux window options).
   */
  adoptTermHosts(): Promise<void> {
    const manager = this.termHosts
    if (!manager) return this.adopted
    this.adopted = (async () => {
      const hosts = await manager.discover()
      for (const host of hosts) {
        try {
          await this._adoptHost(host)
        } catch (err) {
          console.warn(`[PtyManager] adopt ${host.container} failed: ${String(err)}`)
        }
      }
      if (hosts.length)
        console.log(
          `[PtyManager] adopted ${this.sessions.size} terminal session(s) from ${hosts.length} host(s)`,
        )
      await this._loadSleeping()
    })().catch((err) => console.warn(`[PtyManager] terminal host discovery failed: ${String(err)}`))
    return this.adopted
  }

  /**
   * Register the windows of a host that this manager doesn't track yet; drop
   * sessions whose window is gone. A host found frozen (paused while the
   * backend was down) is unpaused to read its windows, and keeps its frozen
   * clock: the next sweep freezes it again from where it was.
   */
  private async _adoptHost(host: TermHost): Promise<void> {
    this._wireHost(host)
    const wasPaused = host.paused
    const windows = await host.listWindows()
    if (wasPaused) {
      const since = Number(await host.serverOption("@teros_paused_at"))
      this.frozenBefore.set(host.appId, since > 0 ? since : Date.now())
    }
    const live = new Set(windows.map((w) => w.terminalId))
    for (const session of [...this.sessions.values()]) {
      if (session.tmux?.host.appId === host.appId && !live.has(session.terminalId)) {
        this._exitSession(session.terminalId, 0, "host_lost")
      }
    }
    for (const win of windows) {
      const existing = this.sessions.get(win.terminalId)
      if (existing?.sleep) {
        // Saved to sleep but its window is still there (a hibernation cut
        // short by a restart): the live window wins, the saved copy goes.
        this._revive(existing, new PaneHandle(host, win), host, win, win.cols, win.rows, null)
        void this.sleepStore?.remove(win.terminalId).catch(() => {})
        continue
      }
      if (existing) {
        if (existing.tmux?.paneId === win.paneId) {
          // Same pane, new control connection: route its output here again.
          existing.tmux.host = host
          this._bindPane(existing.terminalId, existing.ptyProcess as PaneHandle, host, win)
        }
        continue
      }
      const handle = new PaneHandle(host, win)
      this._setupAndStore(
        win.terminalId,
        handle,
        host.container,
        win.workspaceId,
        {
          title: win.title,
          kind: win.kind,
          createdBy: win.createdBy,
          appId: win.appId,
          auth: win.auth,
        },
        false,
      )
      const session = this.sessions.get(win.terminalId)!
      session.createdAt = new Date(win.createdAt || Date.now())
      // tmux's last output: an idle host freezes again on the next sweep.
      session.lastActivity = new Date(win.activityAt || Date.now())
      session.tmux = { host, windowId: win.windowId, paneId: win.paneId }
      session.cols = win.cols
      session.rows = win.rows
      session.command = win.command || null
      session.agentState = parseAgentState(win.agentState)
      if (session.agentState) session.hookAgent = session.command
      session.agentSession = win.agentSession || ""
      session.lease.restore(parseLeaseSnapshot(win.lease))
      this._changed(session, "created")
      // Seed the read buffer from tmux history so terminal-read still works after a restart.
      try {
        const lines = await host.plainHistory(win.paneId, ADOPT_SEED_LINES)
        while (lines.length && lines[lines.length - 1] === "") lines.pop()
        for (const line of lines) this._appendLine(session, line)
      } catch {
        /* best-effort: an empty buffer only affects terminal-read of pre-restart output */
      }
      this._bindPane(win.terminalId, handle, host, win)
    }
  }

  /** Host-level callbacks: subscription changes, pauses and lost connections. */
  private _wireHost(host: TermHost): void {
    host.onAttr = (name, paneId, value) => {
      const session = this._sessionByPane(host, paneId)
      if (!session) return
      if (name === "agent") {
        const next = parseAgentState(value)
        if (
          next?.at.getTime() === session.agentState?.at.getTime() &&
          next?.state === session.agentState?.state
        )
          return
        this._setAgentState(session, next)
        if (next) session.hookAgent = session.command
        this._changed(session, "agent_state")
      } else if (name === "sess") {
        // CCR-REQ-8: the hook reported (or changed) Claude Code's session id.
        if (session.agentSession === value) return
        session.agentSession = value || ""
        this._changed(session, "agent_state")
      } else if (name === "cmd") {
        if (session.command === value) return
        session.command = value || null
        if (session.needsAuth && value !== "claude") session.needsAuth = null
        // The agent left (claude exited or crashed back to the shell): its
        // state is stale. SessionEnd clears it explicitly; this covers kills.
        // Not for a state set in the last seconds — the subscription tick can
        // deliver the hook's own state and an older command change together.
        if (
          session.agentState &&
          isShell(value) &&
          Date.now() - session.agentState.at.getTime() > 3000
        ) {
          this._setAgentState(session, null)
        }
        // A guessed state belongs to the agent it was guessed for.
        if (session.agentState?.source === "heuristic" && !AGENT_COMMANDS.has(value)) {
          this._setAgentState(session, null)
        }
        this._changed(session, "command")
      } else if (name === "title") {
        this._changed(session, "title")
      } else if (name === "bell" && value === "1") {
        this._changed(session, "bell")
      }
    }
    host.onPause = (paneId) => {
      const session = this._sessionByPane(host, paneId)
      if (session) this._changed(session, "resync")
    }
    host.onUnpause = (ms) => {
      // Unpaused to be saved to sleep: not a wake.
      if (this.hibernating.has(host.appId)) return
      this.frozenBefore.delete(host.appId)
      this._countWake("frozen", ms)
      const sessions = this._sessionsOf(host.appId)
      console.log(
        `[PtyManager] terminal host ${host.container} unfrozen in ${ms} ms (${sessions.length} session(s)) · ${this._statsLine()}`,
      )
      for (const s of sessions) this._changed(s, "awake")
    }
    host.onDisconnect = (reason) => {
      console.warn(`[PtyManager] terminal host ${host.container} disconnected: ${reason}`)
      // Reconnect and reconcile: windows still there are re-bound, the rest exit.
      // (A host freezing or saving its sessions to sleep is not lost.)
      setTimeout(() => {
        if (host.paused || this.hibernating.has(host.appId)) return
        if (![...this.sessions.values()].some((s) => s.tmux?.host === host)) return
        this._adoptHost(host).catch((err) => {
          console.warn(`[PtyManager] terminal host ${host.container} is gone: ${String(err)}`)
          for (const s of [...this.sessions.values()]) {
            if (s.tmux?.host === host) this._exitSession(s.terminalId, 0, "host_lost")
          }
        })
      }, 1000).unref?.()
    }
  }

  private _sessionByPane(host: TermHost, paneId: string): ManagedSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.tmux?.host === host && s.tmux.paneId === paneId) return s
    }
    return undefined
  }

  private _bindPane(
    terminalId: string,
    handle: PaneHandle,
    host: TermHost,
    win: { windowId: string; paneId: string },
  ): void {
    host.bind(win.windowId, win.paneId, {
      data: (text) => handle.emitData(text),
      exit: (code) => handle.emitExit(code),
    })
    void terminalId
  }

  /**
   * Create a session in the workspace's terminal host (tmux window). The caller
   * resolved the host (TermHostManager.ensure); `meta` is stored in tmux so the
   * session is recovered as-is after a backend restart.
   */
  async createInHost(
    host: TermHost,
    terminalId: string,
    cols: number,
    rows: number,
    ownerWorkspaceId: string,
    meta: SessionMeta,
    opts: {
      cwd?: string
      command?: string
      env?: Record<string, string>
      /** Waking a sleeping session (SessionWaker): revive it in place with this note. */
      resumed?: Omit<ResumeInfo, "at" | "sleptAt">
    } = {},
  ): Promise<void> {
    const sleeping = this.sessions.get(terminalId)
    if (sleeping && !sleeping.sleep) return
    this._wireHost(host)
    const { resumed, ...windowOpts } = opts
    const windowMeta: TermWindowMeta = {
      terminalId,
      workspaceId: ownerWorkspaceId,
      appId: meta.appId ?? host.appId,
      title: meta.title,
      kind: meta.kind,
      createdBy: meta.createdBy,
      createdAt: sleeping?.createdAt.getTime() ?? Date.now(),
      auth: meta.auth,
    }
    const win = await host.createWindow(windowMeta, { cols, rows, ...windowOpts })
    const current = this.sessions.get(terminalId)
    if (sleeping ? current !== sleeping || !current.sleep : current !== undefined) {
      // Lost a create race for the same id (or the sleeper was closed or woken meanwhile): drop the extra window.
      await host.kill(win.windowId)
      return
    }
    if (sleeping) {
      const sleptAt = sleeping.sleep?.sleptAt ?? new Date()
      this._revive(sleeping, new PaneHandle(host, win), host, win, cols, rows, {
        agent: null,
        notRestored: null,
        message: "Resumed after sleep.",
        ...resumed,
        sleptAt,
        at: new Date(),
      })
      return
    }
    const handle = new PaneHandle(host, win)
    this._setupAndStore(terminalId, handle, host.container, ownerWorkspaceId, meta, false)
    const session = this.sessions.get(terminalId)!
    session.tmux = { host, windowId: win.windowId, paneId: win.paneId }
    session.cols = cols
    session.rows = rows
    this._bindPane(terminalId, handle, host, win)
    this.hostEmptySince.delete(host.appId)
    this._changed(session, "created")
    console.log(`[PtyManager] terminal ${terminalId} → ${host.container} ${win.windowId}`)
  }

  /**
   * Put a live pane behind an existing session object (waking it from sleep,
   * or the live window of a half-finished hibernation). Same object, same
   * read buffer and listeners: cursors and viewers carry over.
   */
  private _revive(
    session: ManagedSession,
    handle: PaneHandle,
    host: TermHost,
    win: { windowId: string; paneId: string },
    cols: number,
    rows: number,
    resumed: ResumeInfo | null,
  ): void {
    this._wirePty(session.terminalId, handle)
    // CCR-REQ-8: keep the Claude Code session id across the wake — the sleep
    // record is cleared below but the id must survive into the fresh runtime.
    const sleptAgentSession = session.agentSession || session.sleep?.agentSession || ""
    session.ptyProcess = handle
    session.containerId = host.container
    session.tmux = { host, windowId: win.windowId, paneId: win.paneId }
    session.sleep = null
    session.agentSession = sleptAgentSession
    session.resumed = resumed
    session.cols = cols
    session.rows = rows
    session.command = null
    session.hookAgent = null
    session.needsAuth = null
    session.heuristicSeenOutput = -1
    if (session.agentState) this._setAgentState(session, null)
    this.linePending.delete(session.terminalId)
    this._touchActivity(session)
    this._bindPane(session.terminalId, handle, host, win)
    this.hostEmptySince.delete(host.appId)
    // The new window carries the driver on (next backend restart).
    this._persistLease(session)
    this._changed(session, "wake")
    console.log(
      `[PtyManager] terminal ${session.terminalId} woke → ${host.container} ${win.windowId}`,
    )
  }

  /**
   * Viewer snapshot: bytes that redraw the session (screen + scrollback +
   * modes) in a reset xterm, and `seq`: output chunks with a higher sequence
   * number are not in it (apply them after), the others are.
   */
  async snapshot(
    terminalId: string,
  ): Promise<{ data: string; cols: number; rows: number; seq: number } | null> {
    const session = this.sessions.get(terminalId)
    if (!session) return null
    if (session.sleep) {
      // Not woken (the caller didn't, or the wake failed): its saved scrollback.
      return {
        data: `\x1bc${session.sleep.history.replace(/\n/g, "\r\n")}`,
        cols: session.cols,
        rows: session.rows,
        seq: session.outputSeq,
      }
    }
    if (session.tmux) {
      let seq = session.outputSeq
      const snap = await session.tmux.host.snapshot(
        session.tmux.paneId,
        SNAPSHOT_HISTORY_LINES,
        () => {
          seq = session.outputSeq
        },
      )
      return { ...snap, seq }
    }
    // Legacy PTY: no server-side screen — replay the raw buffer (approximate for TUIs).
    const pending = this.linePending.get(terminalId) ?? ""
    return {
      data: [...session.buffer, pending].join("\r\n"),
      cols: session.cols,
      rows: session.rows,
      seq: session.outputSeq,
    }
  }

  /** True while a session is in flood mode (viewers get periodic snapshots, not the stream). */
  isFlooding(terminalId: string): boolean {
    return this.sessions.get(terminalId)?.flood != null
  }

  /** Screen-only snapshot (no scrollback): cheap frames while a session floods. */
  async screenSnapshot(
    terminalId: string,
  ): Promise<{ data: string; cols: number; rows: number; seq: number } | null> {
    const session = this.sessions.get(terminalId)
    if (!session?.tmux) return this.snapshot(terminalId)
    let seq = session.outputSeq
    const snap = await session.tmux.host.snapshot(session.tmux.paneId, 0, () => {
      seq = session.outputSeq
    })
    return { ...snap, seq }
  }

  /**
   * Flood detection: a pane producing more than FLOOD_BYTES_PER_SEC for a
   * second, with no programmatic waiter on its output, goes into flood mode —
   * tmux stops sending us its bytes (it still renders them), so `yes` or a
   * huge `cat` costs neither the backend nor the browser; viewers get screen
   * snapshots instead (stream server) and a full one when it calms down.
   */
  private _meterOutput(session: ManagedSession, bytes: number): void {
    session.rateBytes += bytes
    const now = Date.now()
    const elapsed = now - session.rateStart
    if (elapsed < 1000) return
    const rate = (session.rateBytes * 1000) / elapsed
    session.rateBytes = 0
    session.rateStart = now
    if (rate > FLOOD_BYTES_PER_SEC && !session.flood && session.waiters.size === 0)
      this._startFlood(session)
  }

  private _startFlood(session: ManagedSession): void {
    const tmux = session.tmux
    if (!tmux) return
    const timer = setInterval(() => void this._checkFloodEnd(session), 1000)
    timer.unref?.()
    session.flood = { since: Date.now(), timer, lastActivity: 0 }
    void tmux.host.setPaneOutput(tmux.paneId, false).catch(() => {})
    console.log(`[PtyManager] terminal ${session.terminalId}: flood mode on`)
    this._changed(session, "flood_on")
  }

  private async _checkFloodEnd(session: ManagedSession): Promise<void> {
    const flood = session.flood
    if (!flood || !session.tmux) return
    let activity = 0
    try {
      activity = await session.tmux.host.windowActivity(session.tmux.windowId)
    } catch {
      this._endFlood(session)
      return
    }
    session.lastOutputAt = new Date(Math.max(activity, session.lastOutputAt?.getTime() ?? 0))
    this._touchActivity(session)
    // Quiet for a whole tick (tmux keeps activity in seconds): the flood is over.
    if (activity === flood.lastActivity) this._endFlood(session)
    else flood.lastActivity = activity
  }

  private _endFlood(session: ManagedSession): void {
    const flood = session.flood
    if (!flood) return
    clearInterval(flood.timer)
    session.flood = null
    session.rateBytes = 0
    session.rateStart = Date.now()
    if (session.tmux)
      void session.tmux.host.setPaneOutput(session.tmux.paneId, true).catch(() => {})
    console.log(
      `[PtyManager] terminal ${session.terminalId}: flood mode off after ${Date.now() - flood.since} ms`,
    )
    this._changed(session, "flood_off")
  }

  /**
   * Record who typed (presence) and move the wheel (DriverLease): a person
   * typing drives, or is in conflict with the person driving. `who` is the
   * identity on the seat (default: the actor). Agents check agentMayWrite()
   * first. Returns true when the typist changed and nothing was announced
   * (worth telling viewers).
   */
  noteInput(terminalId: string, actor: Omit<InputActor, "at">, who?: CrewIdentity): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    const changed = session.lastInput?.id !== actor.id
    session.lastInput = { ...actor, at: Date.now() }
    const identity = who ?? { kind: actor.kind, id: actor.id, name: actor.name }
    const lease =
      actor.kind === "agent"
        ? session.lease.agentInput(identity)
        : session.lease.humanInput(identity)
    this._leaseChanged(session, lease)
    // Every agent write is news for the window ("follow the agent"); a
    // person's keystrokes only when the typist changes (they are many).
    if (actor.kind === "agent") this._changed(session, "input")
    return changed && lease.length === 0
  }

  // ── Terminal crew: the wheel ──────────────────────────────────────────────

  /** Who drives a session, null when there is no session. */
  driver(terminalId: string): TerminalDriver | null {
    return this.sessions.get(terminalId)?.lease.driver ?? null
  }

  /** May this agent type now? Null when it may, else who holds the wheel (and what to tell the agent). */
  agentMayWrite(terminalId: string, agent: CrewIdentity): WheelHeld | null {
    return this.sessions.get(terminalId)?.lease.agentMay(agent) ?? null
  }

  /** A person takes the wheel (the agent that drove becomes the copilot). False without a session. */
  takeWheel(terminalId: string, who: CrewIdentity): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    this._leaseChanged(session, session.lease.takeWheel(who))
    return true
  }

  /** The person at the wheel gives it back (to the agent before, with a note). Throws LeaseError. */
  giveBack(terminalId: string, who: CrewIdentity, note: string | null): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    this._leaseChanged(session, session.lease.giveBack(who, note))
    return true
  }

  /** In a conflict, cede the wheel to the other person. Throws LeaseError. */
  yieldWheel(terminalId: string, who: CrewIdentity, to: CrewIdentity): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    this._leaseChanged(session, session.lease.yieldTo(who, to))
    return true
  }

  /** The give-back note for this agent, once (then it is gone). */
  takeHandedBack(terminalId: string, agentId: string): TerminalHandedBack | null {
    const session = this.sessions.get(terminalId)
    if (!session) return null
    const handed = session.lease.takeHandedBack(agentId)
    if (handed) this._persistLease(session)
    return handed
  }

  /** When this person last typed in the session (watchers' typingAt). */
  typingAt(terminalId: string, userId: string): number | null {
    return this.sessions.get(terminalId)?.lease.typingAt(userId) ?? null
  }

  /** An agent starts (on: true) or stops waiting on a session: it shows among the watchers. */
  agentWatching(terminalId: string, who: CrewIdentity, on: boolean): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    const entry = session.agentWatchers.get(who.id)
    if (on) {
      if (entry) entry.count++
      else session.agentWatchers.set(who.id, { who, count: 1 })
      if (!entry) this._changed(session, "watchers")
    } else if (entry && --entry.count <= 0) {
      session.agentWatchers.delete(who.id)
      this._changed(session, "watchers")
    }
  }

  /** Agents among a session's watchers: those waiting on it, and the copilot while a person drives. */
  agentWatchers(terminalId: string): TerminalWatcher[] {
    const session = this.sessions.get(terminalId)
    if (!session) return []
    const out = new Map<string, TerminalWatcher>()
    const prior = session.lease.priorAgent
    if (prior && session.lease.driver.kind === "human")
      out.set(prior.id, {
        id: prior.id,
        kind: "agent",
        name: prior.name || "Agent",
        avatarUrl: prior.avatarUrl ?? null,
        typingAt: null,
      })
    for (const { who } of session.agentWatchers.values())
      out.set(who.id, {
        id: who.id,
        kind: "agent",
        name: who.name || "Agent",
        avatarUrl: who.avatarUrl ?? null,
        typingAt: null,
      })
    return [...out.values()]
  }

  /** Tell the session's watchers and viewers something changed (e.g. "watchers" when a viewer comes or goes). */
  announce(terminalId: string, reason: string): void {
    const session = this.sessions.get(terminalId)
    if (session) this._changed(session, reason)
  }

  /** Announce what a lease change touched; persist the driver; schedule the end of a conflict. */
  private _leaseChanged(session: ManagedSession, changes: LeaseChange[]): void {
    if (!changes.length) return
    if (changes.includes("driver")) this._persistLease(session)
    if (changes.includes("conflict")) {
      if (session.conflictTimer) clearTimeout(session.conflictTimer)
      session.conflictTimer = null
      this._scheduleConflictEnd(session)
    }
    for (const reason of new Set(changes)) this._changed(session, reason)
  }

  private _scheduleConflictEnd(session: ManagedSession): void {
    const endsAt = session.lease.conflictEndsAt()
    if (endsAt === null) return
    session.conflictTimer = setTimeout(
      () => {
        session.conflictTimer = null
        if (this.sessions.get(session.terminalId) !== session) return
        if (session.lease.expire()) this._changed(session, "conflict")
        else this._scheduleConflictEnd(session)
      },
      Math.max(50, endsAt - Date.now()),
    )
    session.conflictTimer.unref?.()
  }

  /** The driver survives restarts (tmux window option) and sleep (the sleep record). */
  private _persistLease(session: ManagedSession): void {
    const json = JSON.stringify(session.lease.snapshot())
    if (session.sleep) {
      session.sleep.lease = json
      void this.sleepStore?.setLease?.(session.terminalId, json).catch((err) => {
        console.warn(
          `[PtyManager] could not save the driver of ${session.terminalId}: ${String(err)}`,
        )
      })
    } else if (session.tmux) {
      void session.tmux.host
        .setWindowOption(session.tmux.windowId, "@teros_driver", json)
        .catch(() => {})
    }
  }

  lastInput(terminalId: string): InputActor | null {
    return this.sessions.get(terminalId)?.lastInput ?? null
  }

  /** Rendered screen for agents (rows as the user sees them). Null when the session doesn't exist. */
  async screen(terminalId: string): Promise<RenderedScreen | null> {
    const session = this.sessions.get(terminalId)
    if (!session) return null
    this._touchActivity(session)
    if (session.tmux) return session.tmux.host.screen(session.tmux.paneId)
    const tail = (
      session.sleep ? session.sleep.history.split("\n") : session.buffer.map((l) => stripAnsi(l))
    ).slice(-session.rows)
    return {
      cols: session.cols,
      rows: session.rows,
      lines: tail,
      cursor: { x: 0, y: Math.max(0, tail.length - 1), visible: true },
      title: "",
      command: "",
      alternateScreen: false,
    }
  }

  /** Subscribe to a session's raw output (live viewers). Returns an unsubscribe function. */
  onOutput(terminalId: string, listener: (data: string, seq: number) => void): () => void {
    const session = this.sessions.get(terminalId)
    if (!session) return () => {}
    session.outputListeners.add(listener)
    return () => session.outputListeners.delete(listener)
  }

  async rename(terminalId: string, title: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session) return
    session.meta.title = title.slice(0, 200)
    if (session.sleep) {
      session.sleep.title = session.meta.title
      await this.sleepStore?.rename(terminalId, session.meta.title)
    } else if (session.tmux)
      await session.tmux.host.setWindowOption(
        session.tmux.windowId,
        "@teros_title",
        session.meta.title,
      )
    this._changed(session, "title")
  }

  /** Record a coding agent's state on the session (and in tmux, so it survives restarts). */
  async setAgentState(terminalId: string, state: AgentState | null): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session) return
    this._setAgentState(session, state)
    if (session.tmux) {
      const value = state ? formatAgentState(state) : ""
      await session.tmux.host.setPaneOption(session.tmux.paneId, "@agent_state", value)
    }
    this._changed(session, "agent_state")
  }

  meta(terminalId: string): SessionMeta | undefined {
    return this.sessions.get(terminalId)?.meta
  }

  /** The tmux pane behind a session (terminal-host sessions only). */
  paneOf(terminalId: string): { host: TermHost; windowId: string; paneId: string } | undefined {
    return this.sessions.get(terminalId)?.tmux
  }

  size(terminalId: string): { cols: number; rows: number } | undefined {
    const s = this.sessions.get(terminalId)
    return s ? { cols: s.cols, rows: s.rows } : undefined
  }

  /**
   * Create a new PTY session for a terminal window.
   * Runs bash inside the MCA bash container via docker exec.
   */
  create(
    terminalId: string,
    containerId: string,
    cols: number,
    rows: number,
    ownerWorkspaceId?: string,
  ): void {
    if (this.sessions.has(terminalId)) {
      console.log(`[PtyManager] session ${terminalId} already exists, reusing`)
      return
    }

    console.log(`[PtyManager] creating PTY for terminal ${terminalId} in container ${containerId}`)

    // MCA containers may run on a remote execution host (TWO-HOST-SEPARATION-PLAN
    // phase 3): TERMINAL_DOCKER_HOST (e.g. ssh://user@10.99.0.2) points the
    // docker CLI there. Scoped to the terminal domain on purpose — a global
    // DOCKER_HOST would also redirect any other docker consumer in this env.
    const dockerEnv = process.env.TERMINAL_DOCKER_HOST
      ? { DOCKER_HOST: process.env.TERMINAL_DOCKER_HOST }
      : {}

    const ptyProcess = pty.spawn("docker", ["exec", "-it", containerId, "/bin/bash"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || "/",
      env: { ...process.env, ...dockerEnv, TERM: "xterm-256color" },
    })

    this._setupAndStore(terminalId, ptyProcess, containerId, ownerWorkspaceId)
    const session = this.sessions.get(terminalId)
    if (session) {
      session.cols = cols
      session.rows = rows
    }
  }

  /**
   * Create a PTY session directly on the host (no Docker container).
   * Legacy: kept for in-memory sessions created before the mca.teros.admin.bash
   * retirement (2026-10-19); no caller creates new ones.
   * Authorization is the caller's job (terminal domain: system admins only);
   * the env is scrubbed with hostPtyEnv().
   */
  createHost(terminalId: string, cols: number, rows: number, ownerWorkspaceId?: string): void {
    if (this.sessions.has(terminalId)) {
      console.log(`[PtyManager] session ${terminalId} already exists, reusing`)
      return
    }

    console.log(`[PtyManager] creating HOST PTY for terminal ${terminalId}`)

    const ptyProcess = pty.spawn("/bin/bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || "/",
      env: hostPtyEnv(process.env),
    })

    this._setupAndStore(terminalId, ptyProcess, HOST_CONTAINER_ID, ownerWorkspaceId)
    const session = this.sessions.get(terminalId)
    if (session) {
      session.cols = cols
      session.rows = rows
    }
  }

  /** Route a process's output and exit to its session — only while it is still that session's process. */
  private _wirePty(terminalId: string, ptyProcess: PtyLike): void {
    const current = () => this.sessions.get(terminalId)?.ptyProcess === ptyProcess
    ptyProcess.onData((data: string) => {
      if (current()) this._handleOutput(terminalId, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PtyManager] PTY exited for terminal ${terminalId} (code: ${exitCode})`)
      // A destroyed session's process still announces the end (destroy → kill → exit).
      if (current() || !this.sessions.has(terminalId)) this._exitSession(terminalId, exitCode)
    })
  }

  private _setupAndStore(
    terminalId: string,
    ptyProcess: PtyLike,
    containerId: string,
    ownerWorkspaceId?: string,
    meta?: Partial<SessionMeta>,
    announce = true,
  ): void {
    this._wirePty(terminalId, ptyProcess)

    this.sessions.set(terminalId, {
      terminalId,
      ptyProcess,
      containerId,
      createdAt: new Date(),
      ownerWorkspaceId,
      buffer: [],
      bufferStartLine: 0,
      bufferBytes: 0,
      lastOutputAt: null,
      lastActivity: new Date(),
      waiters: new Set(),
      lastWriteNextLine: 0,
      meta: { title: "", kind: "shell", createdBy: "", ...meta },
      cols: 120,
      rows: 45,
      agentState: null,
      command: null,
      agentSession: "",
      bracketedPaste: false,
      outputListeners: new Set(),
      outputSeq: 0,
      lastInput: null,
      hookAgent: null,
      needsAuth: null,
      rateBytes: 0,
      rateStart: Date.now(),
      flood: null,
      // -1: look once even without new output (a prompt adopted after a restart).
      heuristicSeenOutput: -1,
      stateSeq: 0,
      lastWriteMark: { at: Date.now(), stateSeq: 0 },
      wakers: new Set(),
      sleep: null,
      resumed: null,
      lease: new DriverLease(Date.now, this.leaseOptions),
      agentWatchers: new Map(),
      conflictTimer: null,
    })
    // Host sessions announce themselves once their pane is attached (persistent, real size).
    if (announce) this._changed({ terminalId, ownerWorkspaceId }, "created")

    console.log(`[PtyManager] PTY created for terminal ${terminalId}`)
  }

  // ── Output access ──────────────────────────────────────────────────────────

  /**
   * Read buffered output of a session.
   *
   * Without options: the last DEFAULT_READ_LINES lines, ANSI-stripped.
   * `lines: N`      → the last N lines.
   * `fromLine: C`   → cursor mode: all retained lines at absolute index ≥ C
   *                   (up to the buffer's newest line). Combine with the
   *                   `nextLine` cursor returned here for incremental reads.
   * `raw: true`     → keep ANSI escape codes (default: stripped).
   *
   * Reading counts as activity for the TTL (an agent polling output is an
   * active consumer; a passive poller can use getStatus instead).
   */
  read(terminalId: string, options: ReadOptions = {}): ReadResult {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return { lines: [], fromLine: 0, nextLine: 0, truncated: false, notFound: true }
    }

    this._touchActivity(session)

    const start = session.bufferStartLine
    const end = start + session.buffer.length // exclusive
    const truncated = session.bufferStartLine > 0

    let from: number
    let to: number // exclusive
    if (options.fromLine !== undefined) {
      from = Math.max(options.fromLine, start)
      to = end
    } else {
      const n = options.lines ?? DEFAULT_READ_LINES
      from = Math.max(start, end - Math.max(0, n))
      to = end
    }

    const lines = session.buffer
      .slice(from - start, to - start)
      .map((l) => (options.raw ? l : stripAnsi(l)))

    return { lines, fromLine: from, nextLine: to, truncated }
  }

  /**
   * Wait until the session's output matches `pattern`.
   *
   * Checks the already-buffered lines first, then every incoming output chunk
   * (line-buffered: a partial trailing line is only tested once complete).
   * Resolves with the matching line, or rejects with an Error after
   * `timeoutMs` (default 10s). Waiting counts as activity for the TTL.
   *
   * Default search window: WITHOUT an explicit `fromLine`, the search starts
   * at the cursor captured by the most recent programmatic write() — the
   * "run a command, wait for its output" flow can never match the TTY echo
   * of the command line itself nor stale occurrences from before the write
   * (audit T-004). Pass `fromLine` explicitly to search older output.
   */
  waitFor(
    terminalId: string,
    pattern: string | RegExp,
    options: WaitForOptions = {},
  ): Promise<WaitForResult> {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return Promise.reject(new Error(`waitFor: no session for terminal ${terminalId}`))
    }

    this._touchActivity(session)

    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    // A waiter needs every line: leave flood mode.
    if (session.flood) this._endFlood(session)
    const raw = options.raw ?? false
    const fromLine = options.fromLine ?? session.lastWriteNextLine
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS

    // Already buffered?
    const buffered = this._matchBuffer(session, regex, fromLine, raw)
    if (buffered) return Promise.resolve(buffered)

    return new Promise<WaitForResult>((resolve, reject) => {
      const listener: WaitListener = {
        regex,
        fromLine,
        raw,
        resolve,
        reject,
        timer: setTimeout(() => {
          session.waiters.delete(listener)
          reject(
            new Error(
              `waitFor: timeout after ${timeoutMs}ms waiting for ${String(pattern)} on terminal ${terminalId}`,
            ),
          )
        }, timeoutMs),
      }
      listener.timer.unref?.()
      session.waiters.add(listener)
    })
  }

  // ── Waiting on state (agents driving TUIs) ─────────────────────────────────

  /** Where the session is now: pass to waitUntil-based waits to only accept what happens after. */
  mark(terminalId: string): InputMark | null {
    const session = this.sessions.get(terminalId)
    return session ? { at: Date.now(), stateSeq: session.stateSeq } : null
  }

  /** The mark left by the last programmatic write (terminal.write), null without a session. */
  lastWriteMark(terminalId: string): InputMark | null {
    return this.sessions.get(terminalId)?.lastWriteMark ?? null
  }

  /** The app in the session asked for bracketed paste (DECSET 2004): multi-line text can be pasted. */
  bracketedPaste(terminalId: string): boolean {
    return this.sessions.get(terminalId)?.bracketedPaste ?? false
  }

  /** Ask the person's Terminal window to show this session (terminal_sessions reason "reveal"). */
  reveal(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    this._changed(session, "reveal")
    return true
  }

  /**
   * Resolve with the first non-null result of `check`, which runs right away,
   * on every output chunk and state change of the session, and at least every
   * `tickMs` (time-based conditions such as "quiet for 2 s"). Resolves null on
   * timeout. When the session ends, `check` runs once more with `ended: true`
   * and its result (null → null) is returned. Waiting counts as activity.
   */
  async waitUntil<T>(
    terminalId: string,
    check: (view: WaitView) => T | null | Promise<T | null>,
    opts: { timeoutMs: number; tickMs?: number },
  ): Promise<T | null> {
    const session = this.sessions.get(terminalId)
    if (!session) throw new Error(`waitUntil: no session for terminal ${terminalId}`)
    // A waiter needs real output timing: leave flood mode (as waitFor does).
    if (session.flood) this._endFlood(session)
    const deadline = Date.now() + opts.timeoutMs
    const tickMs = opts.tickMs ?? 250
    for (;;) {
      const ended = this.sessions.get(terminalId) !== session
      const view: WaitView = {
        ended,
        command: session.command,
        agentState: session.agentState,
        stateSeq: session.stateSeq,
        needsAuth: session.needsAuth,
        lastOutputAt: session.lastOutputAt?.getTime() ?? 0,
        outputSeq: session.outputSeq,
        screen: () => (ended ? Promise.resolve(null) : this.screen(terminalId)),
      }
      const result = await check(view)
      if (result !== null || ended) return result
      const left = deadline - Date.now()
      if (left <= 0) return null
      this._touchActivity(session)
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          session.wakers.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, Math.min(tickMs, left))
        session.wakers.add(wake)
      })
    }
  }

  private _wake(session: ManagedSession | undefined): void {
    if (!session || session.wakers.size === 0) return
    for (const wake of [...session.wakers]) wake()
  }

  /** Every agent-state change goes through here (the sequence number tells waits it is new). */
  private _setAgentState(session: ManagedSession, state: AgentState | null): void {
    session.agentState = state
    session.stateSeq++
  }

  // ── Lifecycle: freeze, hibernate, wake ─────────────────────────────────────

  /**
   * Make sure a session runs before it is used: unpause its frozen host, or
   * bring it back from sleep (SessionWaker). Null when it was awake already
   * (or doesn't exist). Concurrent callers share one wake. Throws when a
   * sleeping session cannot be brought back.
   */
  ensureAwake(terminalId: string, by: { userId: string }): Promise<WakeResult | null> {
    const inflight = this.waking.get(terminalId)
    if (inflight) return inflight
    const session = this.sessions.get(terminalId)
    if (!session) return Promise.resolve(null)
    const appId = session.tmux?.host.appId ?? session.sleep?.appId
    const hibernation = appId ? this.hibernating.get(appId) : undefined
    if (!hibernation && !session.sleep && !session.tmux?.host.paused) return Promise.resolve(null)
    const p = (async (): Promise<WakeResult | null> => {
      // Being saved to sleep right now: let that finish, then wake it from sleep.
      if (hibernation) await hibernation
      if (this.sessions.get(terminalId) !== session) return null
      const started = Date.now()
      if (session.sleep) {
        if (!this.waker) throw new Error("this server cannot wake sleeping terminals")
        const record = session.sleep
        this.wakingHosts.set(record.appId, (this.wakingHosts.get(record.appId) ?? 0) + 1)
        try {
          await this.waker(record, by)
        } finally {
          const left = (this.wakingHosts.get(record.appId) ?? 1) - 1
          if (left > 0) this.wakingHosts.set(record.appId, left)
          else this.wakingHosts.delete(record.appId)
        }
        if (session.sleep) throw new Error(`terminal ${terminalId} did not wake`)
        await this.sleepStore?.remove(terminalId).catch((err) => {
          console.warn(`[PtyManager] could not delete the saved ${terminalId}: ${String(err)}`)
        })
        const ms = Date.now() - started
        this._countWake("sleeping", ms)
        this._touchActivity(session)
        console.log(
          `[PtyManager] terminal ${terminalId} woke from sleep in ${ms} ms · ${this._statsLine()}`,
        )
        return { from: "sleeping", ms }
      }
      const host = session.tmux?.host
      if (!host?.paused) return null
      await host.unpause()
      this._touchActivity(session)
      return { from: "frozen", ms: Date.now() - started }
    })().finally(() => this.waking.delete(terminalId))
    this.waking.set(terminalId, p)
    return p
  }

  /** awake, frozen or sleeping (no session: null). */
  lifecycle(terminalId: string): Lifecycle | null {
    const session = this.sessions.get(terminalId)
    return session ? this._lifecycle(session) : null
  }

  private _lifecycle(s: ManagedSession): Lifecycle {
    if (s.sleep) return "sleeping"
    return s.tmux?.host.paused ? "frozen" : "awake"
  }

  /** Counts of sessions and hosts per state, freezes, hibernations and wake latencies. */
  lifecycleStats(): LifecycleStats {
    const sessions: Record<Lifecycle, number> = { awake: 0, frozen: 0, sleeping: 0 }
    for (const s of this.sessions.values()) sessions[this._lifecycle(s)]++
    const hosts = { awake: 0, frozen: 0 }
    for (const h of this.termHosts?.all() ?? []) hosts[h.paused ? "frozen" : "awake"]++
    const { freezes, hibernations, wakes } = this.counters
    return {
      sessions,
      hosts,
      freezes,
      hibernations,
      wakes: { frozen: { ...wakes.frozen }, sleeping: { ...wakes.sleeping } },
    }
  }

  private _statsLine(): string {
    const { sessions, hosts } = this.lifecycleStats()
    return `sessions awake=${sessions.awake} frozen=${sessions.frozen} sleeping=${sessions.sleeping}, hosts awake=${hosts.awake} frozen=${hosts.frozen}`
  }

  private _countWake(from: "frozen" | "sleeping", ms: number): void {
    const w = this.counters.wakes[from]
    w.count++
    w.lastMs = ms
    w.maxMs = Math.max(w.maxMs, ms)
    w.totalMs += ms
  }

  /** Live (not sleeping) sessions of a terminal host. */
  private _sessionsOf(appId: string): ManagedSession[] {
    return [...this.sessions.values()].filter((s) => s.tmux?.host.appId === appId)
  }

  /** Every session of the host has been idle FREEZE_AFTER: `docker pause` it. */
  private async _freeze(host: TermHost, sessions: ManagedSession[], now: number): Promise<void> {
    this.freezing.add(host.appId)
    try {
      await host.pause(this.frozenBefore.get(host.appId) ?? now)
      this.counters.freezes++
      console.log(
        `[PtyManager] froze ${host.container} (${sessions.length} idle session(s)) · ${this._statsLine()}`,
      )
      for (const s of sessions) this._changed(s, "frozen")
    } catch (err) {
      console.warn(`[PtyManager] could not freeze ${host.container}: ${String(err)}`)
    } finally {
      this.freezing.delete(host.appId)
    }
  }

  /** Frozen HIBERNATE_AFTER: save every session of the host, then remove its container. */
  private _hibernate(host: TermHost): Promise<void> {
    const running = this.hibernating.get(host.appId)
    if (running) return running
    const p = this._hibernateNow(host)
      .catch((err) => {
        console.warn(`[PtyManager] could not hibernate ${host.container}: ${String(err)}`)
      })
      .finally(() => this.hibernating.delete(host.appId))
    this.hibernating.set(host.appId, p)
    return p
  }

  private async _hibernateNow(host: TermHost): Promise<void> {
    const store = this.sleepStore
    const termHosts = this.termHosts
    // Without a store, frozen is as deep as a session sleeps.
    if (!store || !termHosts) return
    const sessions = this._sessionsOf(host.appId)
    // Reading the panes needs tmux running (onUnpause ignores it: not a wake).
    await host.unpause()
    const sleptAt = new Date()
    const records: SleepRecord[] = []
    for (const s of sessions) {
      const pane = s.tmux
      if (!pane) continue
      const [info, lines] = await Promise.all([
        host.paneInfo(pane.paneId),
        host.plainHistory(pane.paneId, SLEEP_HISTORY_LINES),
      ])
      records.push({
        terminalId: s.terminalId,
        stackId: termHosts.stackId,
        workspaceId: s.ownerWorkspaceId ?? host.workspaceId,
        appId: s.meta.appId ?? host.appId,
        title: s.meta.title,
        kind: s.meta.kind,
        createdBy: s.meta.createdBy,
        createdAt: s.createdAt,
        auth: s.meta.auth ?? "",
        cwd: info.cwd,
        cols: s.cols,
        rows: s.rows,
        history: boundHistory(lines),
        command: info.command,
        foreground: String(info.pid),
        agentSession: info.agentSession,
        sleptAt,
        lease: JSON.stringify(s.lease.snapshot()),
      })
    }
    // What ran besides the shell (a dev server…): reported when it wakes.
    const args = await host
      .foregroundArgs(records.map((r) => Number(r.foreground)))
      .catch(() => new Map<number, string>())
    for (const r of records) {
      r.foreground = isShell(r.command) ? "" : (args.get(Number(r.foreground)) ?? r.command)
    }
    // A viewer or a waiter showed up while the panes were read: stay awake.
    // (Output alone doesn't count — a TUI repaints when it is unpaused; and
    // a tool call or attach meanwhile waits for this hibernation in
    // ensureAwake, then wakes the session from sleep.)
    const now = this._sessionsOf(host.appId)
    if (
      now.length !== sessions.length ||
      sessions.some((s) => s.outputListeners.size > 0 || s.waiters.size + s.wakers.size > 0)
    ) {
      console.log(`[PtyManager] ${host.container} is in use again: not hibernated`)
      for (const s of now) this._changed(s, "awake")
      return
    }
    for (const r of records) await store.save(r)
    const byId = new Map(records.map((r) => [r.terminalId, r]))
    for (const s of sessions) {
      const record = byId.get(s.terminalId)
      if (record) this._toSleep(s, record)
    }
    this.counters.hibernations++
    this.frozenBefore.delete(host.appId)
    this.hostEmptySince.delete(host.appId)
    await termHosts.remove(host.appId, "hibernated")
    console.log(
      `[PtyManager] hibernated ${host.container}: ${records.length} session(s) saved · ${this._statsLine()}`,
    )
  }

  /** The session's process is gone, its saved copy stands in until it is woken. */
  private _toSleep(session: ManagedSession, record: SleepRecord): void {
    for (const listener of session.waiters) {
      clearTimeout(listener.timer)
      listener.reject(new Error(`waitFor: session ${session.terminalId} fell asleep`))
    }
    session.waiters.clear()
    if (session.flood) clearInterval(session.flood.timer)
    session.flood = null
    session.ptyProcess = new SleepingPty()
    session.tmux = undefined
    session.sleep = record
    session.resumed = null
    session.command = record.command || null
    this._changed(session, "sleep")
  }

  /** Sessions saved to sleep before this boot (skipping any whose window is still live). */
  private async _loadSleeping(): Promise<void> {
    const store = this.sleepStore
    const termHosts = this.termHosts
    if (!store || !termHosts) return
    let records: SleepRecord[]
    try {
      records = await store.load(termHosts.stackId)
    } catch (err) {
      console.warn(`[PtyManager] could not load sleeping terminals: ${String(err)}`)
      return
    }
    let loaded = 0
    for (const r of records) {
      const live = this.sessions.get(r.terminalId)
      if (live) {
        if (!live.sleep) void store.remove(r.terminalId).catch(() => {})
        continue
      }
      this._setupAndStore(
        r.terminalId,
        new SleepingPty(),
        termHosts.containerName(r.appId),
        r.workspaceId,
        { title: r.title, kind: r.kind, createdBy: r.createdBy, appId: r.appId, auth: r.auth },
        false,
      )
      const s = this.sessions.get(r.terminalId)!
      s.createdAt = new Date(r.createdAt)
      s.lastActivity = new Date(r.sleptAt)
      s.cols = r.cols
      s.rows = r.rows
      s.command = r.command || null
      s.sleep = r
      s.lease.restore(parseLeaseSnapshot(r.lease))
      // terminal-read keeps working on what was there.
      for (const line of r.history.split("\n")) this._appendLine(s, line)
      loaded++
    }
    if (loaded)
      console.log(`[PtyManager] ${loaded} sleeping terminal session(s) · ${this._statsLine()}`)
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /**
   * List all active sessions with their metadata. Does NOT count as activity —
   * monitoring must not keep abandoned sessions alive.
   */
  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      terminalId: s.terminalId,
      containerId: s.containerId,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      alive: s.ptyProcess.pid !== undefined,
      bufferSize: s.buffer.length,
      ownerWorkspaceId: s.ownerWorkspaceId,
      ...this._describe(s),
    }))
  }

  /** Policy, labels and live state shared by list() and getStatus(). */
  private _describe(s: ManagedSession) {
    return {
      pinned: true,
      lifecycle: this._lifecycle(s),
      sleptAt: s.sleep?.sleptAt ?? null,
      resumed: s.resumed,
      title: s.meta.title,
      kind: s.meta.kind,
      createdBy: s.meta.createdBy,
      cols: s.cols,
      rows: s.rows,
      command: s.command,
      agentState: s.agentState,
      agentSession: s.agentSession,
      persistent: s.tmux !== undefined || s.sleep !== null,
      auth: s.meta.auth ?? "",
      needsAuth: s.needsAuth,
      lastInput: s.lastInput,
      driver: { ...s.lease.driver },
      conflict: s.lease.conflict,
    }
  }

  /** One session's list() entry, or null. */
  describe(terminalId: string): SessionInfo | null {
    return this.list().find((s) => s.terminalId === terminalId) ?? null
  }

  /**
   * Detailed status of one session, or null if it doesn't exist.
   * Does NOT count as activity (see list()).
   */
  getStatus(terminalId: string): SessionStatus | null {
    const session = this.sessions.get(terminalId)
    if (!session) return null

    return {
      terminalId: session.terminalId,
      containerId: session.containerId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      alive: session.ptyProcess.pid !== undefined,
      bufferSize: session.buffer.length,
      ownerWorkspaceId: session.ownerWorkspaceId,
      ...this._describe(session),
      bufferStartLine: session.bufferStartLine,
      bufferNextLine: session.bufferStartLine + session.buffer.length,
      bufferBytes: session.bufferBytes,
      lastOutputAt: session.lastOutputAt,
      foregroundProcess:
        session.tmux || session.sleep ? session.command : this._getForegroundProcess(session),
    }
  }

  // ── Existing surface (unchanged behavior) ──────────────────────────────────

  /**
   * Check if a PTY session exists for a terminal.
   */
  has(terminalId: string): boolean {
    return this.sessions.has(terminalId)
  }

  /**
   * Workspace that owns the PTY session, or undefined if no session exists
   * (or the session was created without an owner — legacy path).
   */
  ownerOf(terminalId: string): string | undefined {
    return this.sessions.get(terminalId)?.ownerWorkspaceId
  }

  /** True if the session is a host shell (createHost), not a container one. */
  isHost(terminalId: string): boolean {
    return this.sessions.get(terminalId)?.containerId === HOST_CONTAINER_ID
  }

  /**
   * Write input (keystrokes) to the PTY. Counts as activity for the TTL.
   *
   * Returns the post-write cursor: the absolute line index just past the
   * current end of the buffer, PLUS one line reserved for the TTY echo of
   * the written text. The echo always occupies exactly one line — the
   * pending partial line when there is one (real TTY: the echo joins the
   * prompt), otherwise a fresh line — and command output always comes after
   * it. Recorded as the session's default search start for waitFor(), so a
   * pattern contained in the command line can never match its own echo
   * (audit T-004).
   *
   * Pass `{ moveCursor: false }` for raw keystrokes (terminal.input from the
   * UI): typing must not move the waitFor search window — an agent waiting
   * for output would lose matches while the user types partial input.
   */
  write(
    terminalId: string,
    data: string,
    options: { moveCursor?: boolean; mark?: boolean } = {},
  ): number | undefined {
    const session = this.sessions.get(terminalId)
    if (!session) {
      console.warn(`[PtyManager] write: no session for terminal ${terminalId}`)
      return undefined
    }
    this._touchActivity(session)
    if (options.moveCursor !== false) {
      // +1: one line reserved for the echo of the written text (see docblock).
      const cursor = session.bufferStartLine + session.buffer.length + 1
      session.lastWriteNextLine = cursor
      session.lastWriteMark = { at: Date.now(), stateSeq: session.stateSeq }
      session.ptyProcess.write(data)
      return cursor
    }
    // An agent's keystrokes (terminal-send-key) still start a new wait window.
    if (options.mark) session.lastWriteMark = { at: Date.now(), stateSeq: session.stateSeq }
    session.ptyProcess.write(data)
    return undefined
  }

  /**
   * Resize the PTY. Counts as activity for the TTL (the client is attached).
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    this._touchActivity(session)
    if (session.cols === cols && session.rows === rows) return
    session.cols = cols
    session.rows = rows
    session.ptyProcess.resize(cols, rows)
    this._changed(session, "resize")
  }

  /**
   * Destroy a PTY session (the only way a session ends besides its process
   * exiting). Rejects pending waitFor() listeners. A frozen host is unpaused
   * to close the window; a sleeping session only loses its saved copy.
   */
  destroy(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    console.log(`[PtyManager] destroying PTY for terminal ${terminalId}`)
    if (session.sleep) {
      void this.sleepStore?.remove(terminalId).catch((err) => {
        console.warn(`[PtyManager] could not delete sleeping ${terminalId}: ${String(err)}`)
      })
      this._exitSession(terminalId, 0)
      return
    }
    session.ptyProcess.kill()
    this._cleanupSession(terminalId)
  }

  /**
   * Get the container ID for a given app ID by inspecting running Docker containers.
   * Returns null if not found.
   */
  static getContainerIdForApp(appId: string): string | null {
    // Container name pattern: mca-teros-bash-{last 8 chars of appId}
    const suffix = appId.replace("app_", "").slice(-8)
    const containerName = `mca-teros-bash-${suffix}`
    return containerName
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Handle a PTY output chunk: broadcast to subscribers (unchanged behavior),
   * append complete lines to the circular buffer, and check waitFor listeners.
   * Output counts as activity for the TTL.
   */
  private _handleOutput(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) return

    // Live streaming to the terminal window — unchanged behavior.
    this.pubSubService.broadcastToTopic(`terminal:${terminalId}`, {
      type: "terminal_output",
      data,
      terminalId,
    })
    const seq = ++session.outputSeq
    for (const listener of session.outputListeners) listener(data, seq)
    if (session.tmux) this._meterOutput(session, data.length)

    // tmux has no format for bracketed paste: track it so snapshots restore it.
    const bp = bracketedPasteChange(data, session.bracketedPaste)
    if (bp !== null) {
      session.bracketedPaste = bp
      if (session.tmux) {
        void session.tmux.host
          .setPaneOption(session.tmux.paneId, "@teros_bp", bp ? "1" : "0")
          .catch(() => {})
      }
    }

    // Buffer bookkeeping.
    session.lastOutputAt = new Date()
    this._touchActivity(session)

    const pending = this.linePending.get(terminalId) ?? ""
    const parts = (pending + data).split(/\r?\n/)
    // The last element is the remainder: '' if the chunk ended with a newline,
    // otherwise a partial line to carry over to the next chunk.
    const remainder = parts.pop() ?? ""
    this.linePending.set(terminalId, remainder)

    for (const line of parts) {
      this._appendLine(session, line)
    }

    // Con parts.length === 0 pero remainder no vacío el chunk trajo un prompt
    // parcial ('>>> ') — los waiters deben evaluarlo (ver _matchBuffer).
    if (parts.length > 0 || remainder.length > 0) {
      this._checkWaiters(session)
    }
    this._wake(session)
  }

  /** Append one raw line to the circular buffer, enforcing both caps. */
  private _appendLine(session: ManagedSession, rawLine: string): void {
    const buffer = session.buffer
    buffer.push(rawLine)
    session.bufferBytes += Buffer.byteLength(rawLine, "utf8")

    while (
      buffer.length > MAX_BUFFER_LINES ||
      (buffer.length > 1 && session.bufferBytes > MAX_BUFFER_BYTES)
    ) {
      const dropped = buffer.shift()!
      session.bufferBytes -= Buffer.byteLength(dropped, "utf8")
      session.bufferStartLine++
    }
  }

  /** Search the buffer for the first line at/after fromLine matching the regex. */
  private _matchBuffer(
    session: ManagedSession,
    regex: RegExp,
    fromLine: number,
    raw: boolean,
  ): WaitForResult | null {
    const start = session.bufferStartLine
    for (let i = Math.max(fromLine, start) - start; i < session.buffer.length; i++) {
      const rawLine = session.buffer[i]
      const candidate = raw ? rawLine : stripAnsi(rawLine)
      if (regex.test(candidate)) {
        return { matched: true, line: candidate, lineIndex: start + i, nextLine: start + i + 1 }
      }
    }
    // Los prompts interactivos ('>>> ', 'user@host:~$ ') nunca terminan en
    // \n: viven en linePending y nunca llegan a ser líneas completas del
    // buffer. El contrato de waitFor (regex sobre el output, p.ej. '\$ $',
    // '>>>') exige matchearlos — se tratan como línea virtual al final del
    // buffer. Cuando la línea se complete después, quedará en un índice
    // anterior al nextLine devuelto aquí, así que no hay doble match.
    if (fromLine <= start + session.buffer.length) {
      const pending = this.linePending.get(session.terminalId)
      if (pending) {
        const candidate = raw ? pending : stripAnsi(pending)
        if (regex.test(candidate)) {
          const virtualIndex = start + session.buffer.length
          return {
            matched: true,
            line: candidate,
            lineIndex: virtualIndex,
            nextLine: virtualIndex + 1,
          }
        }
      }
    }
    return null
  }

  /** Check pending waitFor listeners against the lines added by the current chunk. */
  private _checkWaiters(session: ManagedSession): void {
    if (session.waiters.size === 0) return
    for (const listener of session.waiters) {
      const match = this._matchBuffer(session, listener.regex, listener.fromLine, listener.raw)
      if (match) {
        clearTimeout(listener.timer)
        session.waiters.delete(listener)
        listener.resolve(match)
      }
    }
  }

  /** Reset the TTL clock: any real interaction (write/read/waitFor/resize/output) counts. */
  private _touchActivity(session: ManagedSession): void {
    session.lastActivity = new Date()
  }

  /** A session ended (process exit, window closed, host lost): clean up and tell subscribers once. */
  private _exitSession(terminalId: string, exitCode: number, reason?: string): void {
    // After destroy() the session is already gone; its process exit still
    // announces the end (as before: destroy → kill → onExit → terminal_exit).
    this._cleanupSession(terminalId)
    // Notify frontend that the session ended
    this.pubSubService.broadcastToTopic(`terminal:${terminalId}`, {
      type: "terminal_exit",
      exitCode,
      terminalId,
      ...(reason ? { reason } : {}),
    })
  }

  /** Remove session state (buffer, pending line, waiters) and reject pending waiters. */
  private _cleanupSession(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (session) {
      for (const listener of session.waiters) {
        clearTimeout(listener.timer)
        listener.reject(new Error(`waitFor: session ${terminalId} ended`))
      }
      session.waiters.clear()
      session.outputListeners.clear()
      if (session.flood) clearInterval(session.flood.timer)
      if (session.conflictTimer) clearTimeout(session.conflictTimer)
      if (session.tmux) this.hostEmptySince.set(session.tmux.host.appId, Date.now())
    }
    this.linePending.delete(terminalId)
    const existed = this.sessions.delete(terminalId)
    if (existed && session) {
      this._changed(session, "exit")
      this._wake(session)
    }
  }

  /**
   * Lifecycle sweep: freeze hosts whose sessions are all idle, hibernate hosts
   * frozen for HIBERNATE_AFTER, remove hosts left without sessions. Nothing
   * here ever ends a session.
   */
  private _lifecycleSweep(now = Date.now()): void {
    if (this.termHosts) {
      for (const host of this.termHosts.all()) {
        const id = host.appId
        if (this.hibernating.has(id) || this.wakingHosts.has(id) || this.freezing.has(id)) continue
        const sessions = this._sessionsOf(id)
        if (!sessions.length) continue // empty hosts: _removeIdleHosts
        if (host.paused) {
          if (now - (host.pausedAt ?? now) >= this.hibernateAfterMs) void this._hibernate(host)
        } else if (
          sessions.every((s) =>
            sessionIsIdle(
              {
                lastActivity: s.lastActivity.getTime(),
                viewers: s.outputListeners.size,
                waiting: s.waiters.size + s.wakers.size,
                flooding: s.flood !== null,
                waking: this.waking.has(s.terminalId),
              },
              now,
              this.freezeAfterMs,
            ),
          )
        ) {
          void this._freeze(host, sessions, now)
        }
      }
    }
    this._removeIdleHosts(now)
    // Drop stale pending-line entries for sessions that no longer exist.
    if (this.linePending.size > 0) {
      for (const terminalId of this.linePending.keys()) {
        if (!this.sessions.has(terminalId)) this.linePending.delete(terminalId)
      }
    }
  }

  /**
   * Screen heuristic for coding agents without hooks (agent-heuristics.ts):
   * only sessions whose foreground command is a known agent, only when they
   * produced output since the last look (or are mid-turn), one capture each.
   */
  private async _heuristicTick(): Promise<void> {
    if (this.heuristicRunning) return
    this.heuristicRunning = true
    try {
      const now = Date.now()
      for (const session of [...this.sessions.values()]) {
        if (!session.tmux || !session.command || !AGENT_COMMANDS.has(session.command)) continue
        // Looking at a frozen host would unpause it (nothing changes in there anyway).
        if (session.tmux.host.paused || this.hibernating.has(session.tmux.host.appId)) continue
        // Claude Code's login screen shows before any hook can run: always watched.
        const loginWatch = session.command === "claude"
        const hooked = session.hookAgent === session.command
        if (hooked && !loginWatch) continue
        const outAt = session.lastOutputAt?.getTime() ?? 0
        const prev = session.agentState?.state ?? null
        const settled = prev !== "working"
        if (outAt === session.heuristicSeenOutput && (settled || hooked)) continue
        session.heuristicSeenOutput = outAt
        let blocked: string | null = null
        try {
          const screen = await session.tmux.host.screen(session.tmux.paneId)
          if (loginWatch) {
            const need = detectLoginScreen(screen.lines) ? "claude" : null
            if (need !== session.needsAuth) {
              session.needsAuth = need
              this._changed(session, "needs_auth")
            }
          }
          if (hooked) continue
          blocked = detectBlocked(screen.lines) ?? detectMenu(screen.lines)
        } catch {
          continue
        }
        const human = session.lastInput?.kind === "human" ? session.lastInput.at : null
        const next = nextHeuristicState({
          now,
          lastOutputAt: outAt,
          lastHumanInputAt: human,
          previous: prev as HeuristicState | null,
          blocked,
        })
        const message = next === "blocked" ? (blocked ?? undefined) : undefined
        if (next === prev && message === session.agentState?.message) continue
        this._setAgentState(session, {
          state: next,
          at: new Date(now),
          source: "heuristic",
          ...(message ? { message } : {}),
        })
        this._changed(session, "agent_state")
      }
    } finally {
      this.heuristicRunning = false
    }
  }

  /** Remove terminal hosts that have had no live session for HOST_IDLE_MS (sleeping sessions need none). */
  private _removeIdleHosts(now: number): void {
    if (!this.termHosts) return
    const inUse = new Set<string>([...this.wakingHosts.keys(), ...this.hibernating.keys()])
    for (const s of this.sessions.values()) if (s.tmux) inUse.add(s.tmux.host.appId)
    for (const host of this.termHosts.all()) {
      if (inUse.has(host.appId)) {
        this.hostEmptySince.delete(host.appId)
        continue
      }
      const since = this.hostEmptySince.get(host.appId)
      if (since === undefined) {
        this.hostEmptySince.set(host.appId, now)
      } else if (now - since >= HOST_IDLE_MS) {
        this.hostEmptySince.delete(host.appId)
        void this.termHosts.remove(host.appId).catch(() => {})
      }
    }
  }

  /**
   * Best-effort foreground process of the PTY: find the child of the shell PID
   * via `ps`. Returns null when the process is gone or ps is unavailable.
   */
  private _getForegroundProcess(session: ManagedSession): string | null {
    const pid = session.ptyProcess.pid
    if (!pid) return null
    try {
      const out = execSync(
        `ps -o pid=,comm= --ppid ${pid} 2>/dev/null | grep -v -w ps | head -1 | awk '{print $2}'`,
        { encoding: "utf8", timeout: 1000 },
      ).trim()
      return out || null
    } catch {
      // ps not available or process already gone — best-effort by design.
      return null
    }
  }
}

/** Stand-in process of a sleeping session: nothing runs until it is woken. */
class SleepingPty implements PtyLike {
  readonly pid = 0
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): void {}
  onExit(): void {}
}

/**
 * Idle enough to freeze: nothing typed or printed (and no agent reading it)
 * for `freezeAfterMs`, no viewer attached, nobody waiting on it, not flooding
 * and not being woken.
 */
export function sessionIsIdle(
  s: { lastActivity: number; viewers: number; waiting: number; flooding: boolean; waking: boolean },
  now: number,
  freezeAfterMs: number,
): boolean {
  return (
    s.viewers === 0 &&
    s.waiting === 0 &&
    !s.flooding &&
    !s.waking &&
    now - s.lastActivity >= freezeAfterMs
  )
}

/** Scrollback kept for a sleeping session: trailing blank rows dropped, at most SLEEP_HISTORY_BYTES (oldest go first). */
export function boundHistory(lines: string[]): string {
  const kept = [...lines]
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop()
  let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0)
  while (kept.length > 1 && bytes > SLEEP_HISTORY_BYTES) {
    bytes -= Buffer.byteLength(kept.shift() ?? "", "utf8") + 1
  }
  return kept.slice(-SLEEP_HISTORY_LINES).join("\n")
}

// ── tmux pane as a PtyLike ───────────────────────────────────────────────────

/**
 * A terminal-host pane behind the PtyLike contract the manager speaks. Writes
 * become `send-keys`, resize `resize-window`, kill `kill-window`; output and
 * exit arrive from the host's control client (bound with TermHost.bind).
 */
class PaneHandle implements PtyLike {
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(e: { exitCode: number }) => void> = []
  readonly pid: number

  constructor(
    private host: TermHost,
    private readonly win: Pick<TermWindow, "windowId" | "paneId" | "panePid">,
  ) {
    this.pid = win.panePid
  }

  write(data: string): void {
    this.host.write(this.win.paneId, data).catch((err) => {
      console.warn(`[PtyManager] write to ${this.win.paneId} failed: ${String(err)}`)
    })
  }

  resize(cols: number, rows: number): void {
    this.host.resize(this.win.windowId, cols, rows).catch(() => {})
  }

  kill(): void {
    void this.host.kill(this.win.windowId)
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListeners.push(listener)
  }

  emitData(data: string): void {
    for (const l of this.dataListeners) l(data)
  }

  emitExit(exitCode: number): void {
    for (const l of this.exitListeners) l({ exitCode })
  }
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "-bash", "login"])

function isShell(command: string): boolean {
  return SHELLS.has(command)
}

const AGENT_STATES: readonly AgentStateName[] = ["working", "blocked", "done", "idle"]

/**
 * `@agent_state` pane option as written by teros-agent-state:
 * `<state>|<unix seconds>|<message>`. Empty or unknown → null.
 */
export function parseAgentState(value: string | undefined): AgentState | null {
  if (!value) return null
  const [state, ts, ...msg] = value.split("|")
  if (!AGENT_STATES.includes(state as AgentStateName)) return null
  // Unix seconds (older helper) or milliseconds (date +%s%3N).
  const n = Number(ts)
  const ms = !Number.isFinite(n) || n <= 0 ? Date.now() : n > 1e11 ? n : n * 1000
  const message = msg.join("|").trim()
  return {
    state: state as AgentStateName,
    at: new Date(ms),
    source: "hook",
    ...(message ? { message } : {}),
  }
}

export function formatAgentState(state: AgentState): string {
  const msg = replaceControls(state.message ?? "", " ", "|")
  return `${state.state}|${state.at.getTime()}|${msg}`
}
