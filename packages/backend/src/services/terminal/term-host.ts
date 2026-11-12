/**
 * Terminal hosts — one long-lived container per workspace bash app that runs
 * the workspace's tmux server. Every Teros terminal session is a window of the
 * `teros` tmux session in there.
 *
 * Why a dedicated container (decision D1 in the terminal-gem report): the MCA
 * lifecycle removes every `mca-*` container on backend boot and shutdown, and
 * idles them out after 30 min. A `teros-term-*` container is outside that
 * lifecycle, so sessions survive tab closes, the inactivity TTL and backend
 * restarts; it runs tmux + shells only (a few MB), never the node MCA.
 *
 * The container is a clone of the warmed bash MCA container (`docker inspect`):
 * same image, bind mounts (/app-data, /workspace), networks (workspace +
 * egress), memory/cpu/pids limits and security options — so the terminal is
 * exactly as isolated as the bash app, and future hardening carries over. Only
 * the entry point changes: `teros-term-host` (persistence bootstrap, then idle).
 *
 * Discovery is by label (`teros.term.stack` = this backend's stack, so two
 * stacks sharing a Docker host never adopt each other's hosts). Docker-only,
 * like the PTY path it replaces (TERMINAL_DOCKER_HOST selects the daemon).
 *
 * Sleep (pty-manager.ts drives it): an idle host is frozen with `docker pause`
 * (cgroup freezer: no CPU, memory and every process kept, back in well under a
 * second). The tmux control client's `docker exec` stream survives a pause —
 * commands written meanwhile run on unpause — but a new `docker exec` fails on
 * a paused container, so every way into the host (ensureControl, runScript)
 * unpauses first: nothing ever waits on a frozen host.
 */

import { spawn } from "child_process"
import { createHash } from "crypto"
import { StringDecoder } from "string_decoder"
import { dockerCliEnv, type ExecStream, spawnDockerExec } from "./exec-stream"
import {
  buildSnapshot,
  PANE_MODES_FORMAT,
  type PaneModes,
  parsePaneModes,
  type RenderedScreen,
  renderedScreen,
  replaceControls,
} from "./snapshot"
import { TmuxControlClient, tmuxQuote } from "./tmux-control"

export const TERM_LABEL_STACK = "teros.term.stack"
export const TERM_LABEL_APP = "teros.term.app"
export const TERM_LABEL_WORKSPACE = "teros.term.workspace"

/** tmux socket name and session inside every host. */
const TMUX_SOCKET = "teros"
const TMUX_SESSION = "teros"

/** Environment of the tmux server (inherited by every pane). */
const TMUX_SERVER_ENV: Record<string, string> = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "truecolor",
  TERM: "xterm-256color",
  TEROS_TERMINAL: "1",
}

/** Session attributes stored as tmux window options — the host is the source of truth across backend restarts. */
export interface TermWindowMeta {
  terminalId: string
  workspaceId: string
  appId: string
  title: string
  /** shell | claude | codex | agent … (what the session was started as). */
  kind: string
  /** userId of the creator, or `agent:<appId>` for sessions opened by a Teros agent. */
  createdBy: string
  createdAt: number
  /** How a coding agent in it signs in (chip text, never a secret), "" for none. */
  auth?: string
}

export interface TermWindow extends TermWindowMeta {
  windowId: string
  paneId: string
  panePid: number
  cols: number
  rows: number
  /** Last pane activity (ms epoch), from tmux. */
  activityAt: number
  command: string
  agentState: string
  /** Claude Code's own session id (`@agent_session`, CCR-REQ-8) — the --resume key, "" until the hook reports it. */
  agentSession: string
  /** Who had the wheel (DriverLease snapshot, JSON), "" when never set. */
  lease: string
}

const META_FIELDS = [
  "#{window_id}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{window_width}",
  "#{window_height}",
  "#{window_activity}",
  "#{pane_current_command}",
  "#{@agent_state}",
  "#{@agent_session}",
  "#{@teros_id}",
  "#{@teros_ws}",
  "#{@teros_app}",
  "#{@teros_pinned}",
  "#{@teros_kind}",
  "#{@teros_by}",
  "#{@teros_created}",
  "#{@teros_auth}",
  "#{@teros_driver}",
  "#{@teros_title}",
].join("\u001f")

function parseWindow(line: string): TermWindow | null {
  const f = line.split("\u001f")
  const terminalId = f[9]
  if (!terminalId) return null // the keeper window, or a window someone opened by hand
  return {
    windowId: f[0],
    paneId: f[1],
    panePid: Number(f[2]) || 0,
    cols: Number(f[3]) || 0,
    rows: Number(f[4]) || 0,
    activityAt: (Number(f[5]) || 0) * 1000,
    command: f[6] ?? "",
    agentState: f[7] ?? "",
    agentSession: f[8] ?? "",
    terminalId,
    workspaceId: f[10] ?? "",
    appId: f[11] ?? "",
    // f[12]: @teros_pinned of older sessions — read and ignored (every session is kept now).
    kind: f[13] || "shell",
    createdBy: f[14] ?? "",
    createdAt: Number(f[15]) || 0,
    auth: f[16] ?? "",
    lease: f[17] ?? "",
    // Last: a title may hold the separator.
    title: f.slice(18).join("\u001f"),
  }
}

/** Remove control characters from strings stored in tmux options (titles come from users). */
function clean(value: string): string {
  return replaceControls(value, " ").slice(0, 200)
}

// ── docker CLI helper ───────────────────────────────────────────────────────

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
}

export type DockerRunner = (
  args: string[],
  timeoutMs?: number,
  input?: string,
) => Promise<DockerResult>

export const runDocker: DockerRunner = (args, timeoutMs = 30_000, input) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, {
      env: dockerCliEnv(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    if (input !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    }
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr || err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })

// ── Pane sink: how a host hands a pane's output/exit to the session registry ─

export interface PaneSink {
  data(text: string): void
  exit(code: number): void
}

/** Output of panes nobody registered yet (output can race the new-window reply). Bounded. */
const ORPHAN_BUFFER_MAX = 64 * 1024

// ── TermHost ────────────────────────────────────────────────────────────────

export class TermHost {
  private control: TmuxControlClient | null = null
  private connecting: Promise<TmuxControlClient> | null = null
  private sinks = new Map<string, PaneSink>()
  private decoders = new Map<string, StringDecoder>()
  private orphans = new Map<string, string>()
  /** windowId → paneId, for %window-close. */
  private windowPanes = new Map<string, string>()
  /** Subscription values per pane (agent state, foreground command, bell). */
  private paneAttrs = new Map<string, Record<string, string>>()
  /** Called when a subscribed pane attribute changes (name, paneId, value). */
  onAttr: ((name: string, paneId: string, value: string) => void) | null = null
  /** Called when tmux pauses a pane's output for this client (backend fell behind). */
  onPause: ((paneId: string) => void) | null = null
  /** Called when the control connection drops (container stopped, tmux died). */
  onDisconnect: ((reason: string) => void) | null = null
  /** Called after the host was unpaused, with how long the unpause took (ms). */
  onUnpause: ((ms: number) => void) | null = null
  lastUsed = Date.now()
  /** Frozen (`docker pause`). Set before the pause starts, so no new command can slip into a freezing host. */
  paused = false
  /** Since when it is frozen (ms epoch), carried over a backend restart. */
  pausedAt: number | null = null
  /** Pause/unpause run one after the other. */
  private transition: Promise<void> = Promise.resolve()
  private unpausing: Promise<void> | null = null

  constructor(
    readonly container: string,
    readonly appId: string,
    readonly workspaceId: string,
    private readonly execStream: (
      container: string,
      argv: string[],
      env: Record<string, string>,
    ) => ExecStream,
    private readonly docker: DockerRunner,
    private readonly historyLimit: number,
  ) {}

  get connected(): boolean {
    return this.control?.alive === true
  }

  /** Start the tmux server if needed and attach the control client (idempotent, coalesced). Unpauses a frozen host. */
  ensureControl(): Promise<TmuxControlClient> {
    if (this.paused) return this.unpause().then(() => this.ensureControl())
    if (this.control?.alive) return Promise.resolve(this.control)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<TmuxControlClient> {
    const envArgs = Object.entries(TMUX_SERVER_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    // The keeper window holds the session open when no terminal is left; it is
    // never listed (no @teros_id) and costs one idle `tail` process.
    const boot = await this.docker([
      "exec",
      ...envArgs,
      this.container,
      "sh",
      "-c",
      `tmux -L ${TMUX_SOCKET} has-session -t ${TMUX_SESSION} 2>/dev/null || ` +
        `tmux -L ${TMUX_SOCKET} -f /dev/null new-session -d -s ${TMUX_SESSION} -n keep -x 200 -y 50 'exec tail -f /dev/null'`,
    ])
    if (boot.code !== 0)
      throw new Error(`terminal host ${this.container}: tmux did not start: ${boot.stderr.trim()}`)

    const stream = this.execStream(
      this.container,
      ["tmux", "-L", TMUX_SOCKET, "-C", "attach", "-t", TMUX_SESSION],
      TMUX_SERVER_ENV,
    )
    const control = new TmuxControlClient(stream)
    control.on({
      output: (paneId, bytes) => this.paneOutput(paneId, bytes),
      windowClose: (windowId) => this.windowClosed(windowId),
      subscription: ({ name, paneId, value }) => {
        const attrs = this.paneAttrs.get(paneId) ?? {}
        if (attrs[name] === value) return
        attrs[name] = value
        this.paneAttrs.set(paneId, attrs)
        this.onAttr?.(name, paneId, value)
      },
      pause: (paneId) => {
        // Resume right away and let viewers resync from a snapshot: dropped
        // output is never replayed, the grid in tmux stays authoritative.
        void control.command(`refresh-client -A '${paneId}:continue'`).catch(() => {})
        this.onPause?.(paneId)
      },
      exit: (reason) => {
        if (this.control === control) this.control = null
        this.onDisconnect?.(reason)
      },
    })
    // Server-wide options (idempotent). Never the global `window-size manual`:
    // tmux 3.3a's server dies when a control client attaches with it set; each
    // window becomes manual through resize-window instead.
    const setup = [
      `set -g history-limit ${this.historyLimit}`,
      "set -g remain-on-exit off",
      "set -g automatic-rename off",
      "set -g default-terminal xterm-256color",
      // Interactive, non-login bash: a login shell sources /etc/profile, which
      // resets PATH and drops the image's /app-data tool dirs (npm -g, pip --user).
      'set -g default-command "exec bash"',
      "set -s escape-time 0",
      // Coding agents (Claude Code) track focus; without it they print a hint about it.
      "set -g focus-events on",
      "set -g exit-empty off",
      ...Object.entries(TMUX_SERVER_ENV).map(([k, v]) => `set-environment -g ${k} ${tmuxQuote(v)}`),
      // Pause a pane's output to this client when it is >5 s behind: the
      // backend is never buried by a runaway producer (yes, cat bigfile).
      "refresh-client -f pause-after=5",
      `refresh-client -B ${tmuxQuote("agent:%*:#{@agent_state}")}`,
      `refresh-client -B ${tmuxQuote("sess:%*:#{@agent_session}")}`,
      `refresh-client -B ${tmuxQuote("cmd:%*:#{pane_current_command}")}`,
      `refresh-client -B ${tmuxQuote("title:%*:#{pane_title}")}`,
      `refresh-client -B ${tmuxQuote("bell:%*:#{window_bell_flag}")}`,
    ]
    await Promise.all(setup.map((c) => control.command(c)))
    // ~/.local/bin (where the Claude Code and herdr installers put their
    // binaries, on the persistent volume) joins PATH for every new session.
    const [pathLine] = await control.command("show-environment -g PATH").catch(() => [""])
    const [homeLine] = await control.command("show-environment -g HOME").catch(() => [""])
    const path = pathLine?.startsWith("PATH=") ? pathLine.slice(5) : ""
    const home = homeLine?.startsWith("HOME=") ? homeLine.slice(5) : ""
    if (path && home && !path.split(":").includes(`${home}/.local/bin`)) {
      await control.command(`set-environment -g PATH ${tmuxQuote(`${home}/.local/bin:${path}`)}`)
    }
    this.control = control
    return control
  }

  private paneOutput(paneId: string, bytes: Buffer): void {
    let decoder = this.decoders.get(paneId)
    if (!decoder) {
      decoder = new StringDecoder("utf8")
      this.decoders.set(paneId, decoder)
    }
    const text = decoder.write(bytes)
    if (!text) return
    const sink = this.sinks.get(paneId)
    if (sink) {
      sink.data(text)
      return
    }
    const prev = this.orphans.get(paneId) ?? ""
    this.orphans.set(paneId, (prev + text).slice(-ORPHAN_BUFFER_MAX))
  }

  private windowClosed(windowId: string): void {
    const paneId = this.windowPanes.get(windowId)
    if (!paneId) return
    this.windowPanes.delete(windowId)
    const sink = this.sinks.get(paneId)
    this.forgetPane(paneId)
    sink?.exit(0)
  }

  private forgetPane(paneId: string): void {
    this.sinks.delete(paneId)
    this.decoders.delete(paneId)
    this.orphans.delete(paneId)
    this.paneAttrs.delete(paneId)
  }

  /** Route a pane's output and exit to `sink`; replays what arrived before registration. */
  bind(windowId: string, paneId: string, sink: PaneSink): void {
    this.windowPanes.set(windowId, paneId)
    this.sinks.set(paneId, sink)
    const early = this.orphans.get(paneId)
    this.orphans.delete(paneId)
    if (early) sink.data(early)
  }

  attr(paneId: string, name: string): string | undefined {
    return this.paneAttrs.get(paneId)?.[name]
  }

  async createWindow(
    meta: TermWindowMeta,
    opts: {
      cols: number
      rows: number
      cwd?: string
      command?: string
      env?: Record<string, string>
    },
  ): Promise<TermWindow> {
    const control = await this.ensureControl()
    this.lastUsed = Date.now()
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `-e ${tmuxQuote(`${k}=${v}`)}`)
    const cwd = opts.cwd ? `-c ${tmuxQuote(opts.cwd)}` : ""
    const command = opts.command ? tmuxQuote(opts.command) : ""
    const [line] = await control.command(
      `new-window -d -t ${TMUX_SESSION}: ${cwd} ${env.join(" ")} -P -F '#{window_id} #{pane_id} #{pane_pid}' ${command}`.replace(
        / +/g,
        " ",
      ),
    )
    const [windowId, paneId, pid] = (line ?? "").split(" ")
    if (!windowId || !paneId)
      throw new Error(`terminal host ${this.container}: new-window returned "${line}"`)
    const target = `-t ${windowId}`
    await Promise.all([
      control.command(`resize-window ${target} -x ${opts.cols} -y ${opts.rows}`),
      control.command(`set -w ${target} @teros_id ${tmuxQuote(meta.terminalId)}`),
      control.command(`set -w ${target} @teros_ws ${tmuxQuote(meta.workspaceId)}`),
      control.command(`set -w ${target} @teros_app ${tmuxQuote(meta.appId)}`),
      control.command(`set -w ${target} @teros_kind ${tmuxQuote(clean(meta.kind))}`),
      control.command(`set -w ${target} @teros_by ${tmuxQuote(clean(meta.createdBy))}`),
      control.command(`set -w ${target} @teros_created ${meta.createdAt}`),
      control.command(`set -w ${target} @teros_title ${tmuxQuote(clean(meta.title))}`),
      control.command(`set -w ${target} @teros_auth ${tmuxQuote(clean(meta.auth ?? ""))}`),
    ])
    return {
      ...meta,
      windowId,
      paneId,
      panePid: Number(pid) || 0,
      cols: opts.cols,
      rows: opts.rows,
      activityAt: Date.now(),
      command: "",
      agentState: "",
      agentSession: "",
      lease: "",
    }
  }

  async listWindows(): Promise<TermWindow[]> {
    const control = await this.ensureControl()
    const lines = await control.command(
      `list-windows -t ${TMUX_SESSION} -F ${tmuxQuote(META_FIELDS)}`,
    )
    return lines.map(parseWindow).filter((w): w is TermWindow => w !== null)
  }

  async setWindowOption(windowId: string, name: string, value: string): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`set -w -t ${windowId} ${name} ${tmuxQuote(clean(value))}`)
  }

  async setPaneOption(paneId: string, name: string, value: string): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`set -p -t ${paneId} ${name} ${tmuxQuote(clean(value))}`)
  }

  async write(paneId: string, data: string): Promise<void> {
    const control = await this.ensureControl()
    this.lastUsed = Date.now()
    await control.sendInput(paneId, data)
  }

  async resize(windowId: string, cols: number, rows: number): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`resize-window -t ${windowId} -x ${cols} -y ${rows}`)
  }

  async kill(windowId: string): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`kill-window -t ${windowId}`).catch(() => {})
  }

  async modes(paneId: string): Promise<PaneModes> {
    const control = await this.ensureControl()
    const [line] = await control.command(`display -p -t ${paneId} ${tmuxQuote(PANE_MODES_FORMAT)}`)
    return parsePaneModes(line ?? "")
  }

  /** Viewer snapshot (history + screen + modes), at most `maxHistory` scrollback lines. */
  async snapshot(
    paneId: string,
    maxHistory: number,
    atReply?: () => void,
  ): Promise<{ data: string; cols: number; rows: number }> {
    const control = await this.ensureControl()
    // Commands are answered in order, so modes and captures describe the same instant.
    const none = (): string[] => []
    const modesP = control.command(`display -p -t ${paneId} ${tmuxQuote(PANE_MODES_FORMAT)}`)
    const histP =
      maxHistory > 0
        ? control.command(`capture-pane -p -e -N -t ${paneId} -S -${maxHistory} -E -1`).catch(none)
        : Promise.resolve([])
    const savedP = control.command(`capture-pane -p -e -N -a -q -t ${paneId}`).catch(none)
    const screenP = control.command(`capture-pane -p -e -N -t ${paneId}`, atReply)
    const [modesLines, history, savedMain, screen] = await Promise.all([
      modesP,
      histP,
      savedP,
      screenP,
    ])
    const modes = parsePaneModes(modesLines[0] ?? "")
    const data = buildSnapshot({
      modes,
      history: modes.historySize > 0 ? history : [],
      screen,
      savedMain: modes.alternateOn ? savedMain : undefined,
    })
    return { data, cols: modes.cols, rows: modes.rows }
  }

  /**
   * Stop (or resume) sending this pane's output to our control client. tmux
   * keeps reading the pane and updating its grid, so snapshots stay exact.
   *
   * `pause`/`continue`, never `off`: in tmux 3.3a, `refresh-client -A %N:off`
   * on a pane that is flooding kills the whole server (every session of the
   * workspace) — reproduced with `yes | head -c 50M`. `pause` discards the
   * pane's output for this client only and is what pause-after uses itself.
   */
  async setPaneOutput(paneId: string, on: boolean): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`refresh-client -A '${paneId}:${on ? "continue" : "pause"}'`)
  }

  /** Last output time of a window (tmux keeps it with 1 s resolution), ms epoch. */
  async windowActivity(windowId: string): Promise<number> {
    const control = await this.ensureControl()
    const [line] = await control.command(`display -p -t ${windowId} '#{window_activity}'`)
    return (Number(line) || 0) * 1000
  }

  /** Rendered screen for agents: rows as the user sees them, cursor, title, foreground command. */
  async screen(paneId: string): Promise<RenderedScreen> {
    const control = await this.ensureControl()
    const modesP = control.command(`display -p -t ${paneId} ${tmuxQuote(PANE_MODES_FORMAT)}`)
    const screenP = control.command(`capture-pane -p -t ${paneId}`)
    const [modesLines, screen] = await Promise.all([modesP, screenP])
    return renderedScreen(parsePaneModes(modesLines[0] ?? ""), screen)
  }

  /** Plain history + screen lines (wrapped lines joined) — seeds the read buffer of adopted sessions. */
  async plainHistory(paneId: string, maxLines: number): Promise<string[]> {
    const control = await this.ensureControl()
    return control.command(`capture-pane -p -J -t ${paneId} -S -${maxLines}`)
  }

  /** Where a pane is and what runs in it: cwd, foreground command, shell pid, Claude Code session id. */
  async paneInfo(
    paneId: string,
  ): Promise<{ cwd: string; command: string; pid: number; agentSession: string }> {
    const control = await this.ensureControl()
    const [line] = await control.command(
      `display -p -t ${paneId} ${tmuxQuote("#{pane_current_path}\u001f#{pane_current_command}\u001f#{pane_pid}\u001f#{@agent_session}")}`,
    )
    const [cwd = "", command = "", pid = "", agentSession = ""] = (line ?? "").split("\u001f")
    return { cwd, command, pid: Number(pid) || 0, agentSession }
  }

  /** Command lines of the processes running under each shell pid (empty: nothing but the shell). */
  async foregroundArgs(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    const valid = pids.filter((p) => Number.isInteger(p) && p > 0)
    if (!valid.length) return out
    const r = await this.runScript(
      valid
        .map((p) => `printf '%s\\t%s\\n' ${p} "$(ps -o args= --ppid ${p} | head -1)"`)
        .join("\n"),
      15_000,
    )
    for (const row of r.stdout.split("\n")) {
      const tab = row.indexOf("\t")
      if (tab > 0)
        out.set(
          Number(row.slice(0, tab)),
          row
            .slice(tab + 1)
            .trim()
            .slice(0, 300),
        )
    }
    return out
  }

  /** A tmux server option (e.g. @teros_paused_at), "" when unset. */
  async serverOption(name: string): Promise<string> {
    const control = await this.ensureControl()
    const [line] = await control.command(`show -gv ${name}`).catch(() => [""])
    return line ?? ""
  }

  /**
   * Freeze the host: `docker pause`. `at` is when it counts as frozen from
   * (kept in a tmux option, so a backend restart doesn't reset the clock to
   * hibernation). A command still in flight when the freeze lands (a request
   * that raced it) would wait for the next unpause: then it unpauses at once.
   */
  pause(at = Date.now()): Promise<void> {
    const op = this.transition.then(async () => {
      if (this.paused) return
      const control = await this.ensureControl()
      await control.command(`set -g @teros_paused_at ${at}`).catch(() => [])
      this.paused = true
      this.pausedAt = at
      const r = await this.docker(["pause", this.container], 15_000)
      if (r.code !== 0 && !/already paused/i.test(r.stderr)) {
        this.paused = false
        this.pausedAt = null
        throw new Error(`terminal host ${this.container}: pause failed: ${r.stderr.trim()}`)
      }
      if (control.busy) await this.unpauseNow(Date.now())
    })
    this.transition = op.catch(() => {})
    return op
  }

  /** Unfreeze the host (coalesced; a no-op when it isn't frozen). */
  unpause(): Promise<void> {
    if (!this.paused) return Promise.resolve()
    if (!this.unpausing) {
      const started = Date.now()
      const op = this.transition.then(() => this.unpauseNow(started))
      this.transition = op.catch(() => {})
      this.unpausing = op.finally(() => {
        this.unpausing = null
      })
    }
    return this.unpausing
  }

  private async unpauseNow(started: number): Promise<void> {
    if (!this.paused) return
    const r = await this.docker(["unpause", this.container], 15_000)
    if (r.code !== 0 && !/is not paused/i.test(r.stderr))
      throw new Error(`terminal host ${this.container}: unpause failed: ${r.stderr.trim()}`)
    this.paused = false
    this.pausedAt = null
    this.onUnpause?.(Date.now() - started)
  }

  // ── Scratch sessions: private flows no viewer can attach to ─────────────
  // A separate tmux session (not `teros`): our control client never streams
  // it, discovery never adopts it, and kill-session takes its history along.

  async startScratch(
    name: string,
    command: string,
    env: Record<string, string> = {},
    cols = 200,
    rows = 50,
  ): Promise<void> {
    const control = await this.ensureControl()
    const envArgs = Object.entries(env).map(([k, v]) => `-e ${tmuxQuote(`${k}=${v}`)}`)
    await control.command(
      `new-session -d -s ${tmuxQuote(name)} -x ${cols} -y ${rows} ${envArgs.join(" ")} ${tmuxQuote(command)}`.replace(
        / +/g,
        " ",
      ),
    )
  }

  /** Rendered rows of a scratch session (trailing spaces trimmed). */
  async scratchLines(name: string): Promise<string[]> {
    const control = await this.ensureControl()
    const lines = await control.command(`capture-pane -p -t ${tmuxQuote(`${name}:`)}`)
    return lines.map((l) => l.replace(/\s+$/, ""))
  }

  async scratchType(name: string, text: string): Promise<void> {
    const control = await this.ensureControl()
    const paneLine = await control.command(`display -p -t ${tmuxQuote(`${name}:`)} '#{pane_id}'`)
    await control.sendInput(paneLine[0] ?? "", text)
  }

  async killScratch(name: string): Promise<void> {
    const control = await this.ensureControl()
    await control.command(`kill-session -t ${tmuxQuote(name)}`).catch(() => {})
  }

  /** Run a bash script (stdin) in the host container, as root, outside any session. */
  async runScript(script: string, timeoutMs = 60_000): Promise<DockerResult> {
    if (this.paused) await this.unpause()
    return this.docker(["exec", "-i", this.container, "bash", "-s"], timeoutMs, script)
  }

  disconnect(): void {
    this.control?.close()
    this.control = null
  }
}

// ── TermHostManager ─────────────────────────────────────────────────────────

export interface TermHostManagerOptions {
  /** Distinguishes stacks sharing one Docker daemon (default: the Mongo database name). */
  stackId?: string
  docker?: DockerRunner
  execStream?: (container: string, argv: string[], env: Record<string, string>) => ExecStream
  /** Max terminal hosts this backend runs (TERMINAL_MAX_HOSTS, default 100). */
  maxHosts?: number
  /** tmux history-limit per pane (TERMINAL_HISTORY_LIMIT, default 10000). */
  historyLimit?: number
}

/** Bind mounts of the MCA container the terminal host does not need (MCA source, SDK, entry point). */
const SKIPPED_MOUNT_PREFIXES = ["/app/mca", "/opt/teros", "/entrypoint"]

/** Env of the MCA container never copied into the host (callback token, MCA wiring). */
const SKIPPED_ENV = /^(MCA_|NODE_ENV=|HOSTNAME=)/

interface InspectedContainer {
  Config: { Image: string; Env?: string[]; WorkingDir?: string }
  HostConfig: {
    Memory?: number
    MemorySwap?: number
    NanoCpus?: number
    PidsLimit?: number | null
    SecurityOpt?: string[] | null
    CapDrop?: string[] | null
    CapAdd?: string[] | null
    ExtraHosts?: string[] | null
    Dns?: string[] | null
  }
  Mounts?: Array<{ Type: string; Source: string; Name?: string; Destination: string; RW: boolean }>
  NetworkSettings?: { Networks?: Record<string, unknown> }
}

export class TermHostManager {
  private hosts = new Map<string, TermHost>()
  private starting = new Map<string, Promise<TermHost>>()
  readonly stackId: string
  private readonly docker: DockerRunner
  private readonly execStream: (
    container: string,
    argv: string[],
    env: Record<string, string>,
  ) => ExecStream
  private readonly maxHosts: number
  private readonly historyLimit: number

  constructor(options: TermHostManagerOptions = {}) {
    this.stackId = sanitize(
      options.stackId ?? process.env.TERMINAL_STACK_ID ?? process.env.MONGODB_DATABASE ?? "teros",
    )
    this.docker = options.docker ?? runDocker
    this.execStream = options.execStream ?? ((c, argv, env) => spawnDockerExec(c, argv, { env }))
    this.maxHosts = options.maxHosts ?? (Number(process.env.TERMINAL_MAX_HOSTS) || 100)
    this.historyLimit =
      options.historyLimit ?? (Number(process.env.TERMINAL_HISTORY_LIMIT) || 10_000)
  }

  /** Container name of the host for a bash app: stack-scoped, deterministic. */
  containerName(appId: string): string {
    const stack = createHash("sha256").update(this.stackId).digest("hex").slice(0, 6)
    return `teros-term-${stack}-${appId
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-8)
      .toLowerCase()}`
  }

  get(appId: string): TermHost | undefined {
    return this.hosts.get(appId)
  }

  all(): TermHost[] {
    return [...this.hosts.values()]
  }

  /** The running host for this app, if there is one (no container is started). */
  async running(appId: string): Promise<TermHost | null> {
    const known = this.hosts.get(appId)
    if (known && (await this.isRunning(known.container))) return known
    return null
  }

  /**
   * Get or create the host for a bash app. `cloneFrom` is the warmed bash MCA
   * container whose configuration the host copies; it is only read when the
   * host has to be created.
   */
  ensure(appId: string, workspaceId: string, cloneFrom: () => Promise<string>): Promise<TermHost> {
    const pending = this.starting.get(appId)
    if (pending) return pending
    const p = this.ensureInner(appId, workspaceId, cloneFrom).finally(() =>
      this.starting.delete(appId),
    )
    this.starting.set(appId, p)
    return p
  }

  private async ensureInner(
    appId: string,
    workspaceId: string,
    cloneFrom: () => Promise<string>,
  ): Promise<TermHost> {
    const name = this.containerName(appId)
    const known = this.hosts.get(appId)
    if (known && (await this.isRunning(name))) return known
    if (!(await this.isRunning(name))) {
      if (this.hosts.size >= this.maxHosts && !known) {
        throw new Error(
          `Terminal host limit reached (${this.maxHosts}). Close idle terminals and retry.`,
        )
      }
      await this.create(name, appId, workspaceId, await cloneFrom())
    }
    const host = this.track(
      new TermHost(name, appId, workspaceId, this.execStream, this.docker, this.historyLimit),
    )
    await host.ensureControl()
    return host
  }

  private track(host: TermHost): TermHost {
    this.hosts.get(host.appId)?.disconnect()
    this.hosts.set(host.appId, host)
    return host
  }

  private async isRunning(name: string): Promise<boolean> {
    const r = await this.docker(["inspect", "--format", "{{.State.Running}}", name], 15_000)
    return r.code === 0 && r.stdout.trim() === "true"
  }

  /** `docker run` the host as a clone of the bash MCA container's isolation settings. */
  private async create(
    name: string,
    appId: string,
    workspaceId: string,
    source: string,
  ): Promise<void> {
    const inspect = await this.docker(["inspect", source], 15_000)
    if (inspect.code !== 0) throw new Error(`cannot inspect ${source}: ${inspect.stderr.trim()}`)
    const [info] = JSON.parse(inspect.stdout) as InspectedContainer[]
    const args = cloneRunArgs(info, {
      name,
      labels: {
        [TERM_LABEL_STACK]: this.stackId,
        [TERM_LABEL_APP]: appId,
        [TERM_LABEL_WORKSPACE]: workspaceId,
      },
    })
    await this.docker(["rm", "-f", name], 30_000)
    const run = await this.docker(args.run, 120_000)
    if (run.code !== 0)
      throw new Error(
        `terminal host ${name} did not start: ${run.stderr.trim() || run.stdout.trim()}`,
      )
    for (const net of args.extraNetworks) {
      await this.docker(["network", "connect", net, name], 15_000)
    }
    console.log(`[TermHost] started ${name} for app ${appId} (clone of ${source})`)
  }

  /** Re-attach every host of this stack still running or frozen (backend boot). Returns them. */
  async discover(): Promise<TermHost[]> {
    const r = await this.docker(
      [
        "ps",
        "--filter",
        `label=${TERM_LABEL_STACK}=${this.stackId}`,
        "--format",
        `{{.Names}}\t{{.Label "${TERM_LABEL_APP}"}}\t{{.Label "${TERM_LABEL_WORKSPACE}"}}\t{{.State}}`,
      ],
      30_000,
    )
    if (r.code !== 0) return []
    const found: TermHost[] = []
    for (const row of r.stdout.split("\n").filter(Boolean)) {
      const [name, appId, workspaceId, state] = row.split("\t")
      if (!name || !appId || !workspaceId) continue
      const host = this.track(
        new TermHost(name, appId, workspaceId, this.execStream, this.docker, this.historyLimit),
      )
      // Frozen, not dead (`docker ps` lists paused containers): the first command unpauses it.
      host.paused = state === "paused"
      found.push(host)
    }
    return found
  }

  /**
   * Remove a host container: no terminal left in it, or (`why: "hibernated"`)
   * its sessions were saved to sleep. The tmux server is stopped first, so the
   * shells get their SIGHUP and save their history on the persistent volume.
   */
  async remove(appId: string, why = "no terminals left"): Promise<void> {
    const host = this.hosts.get(appId)
    host?.disconnect()
    this.hosts.delete(appId)
    const name = this.containerName(appId)
    await this.docker(["unpause", name], 15_000)
    await this.docker(["exec", name, "tmux", "-L", TMUX_SOCKET, "kill-server"], 15_000)
    await this.docker(["rm", "-f", name], 30_000)
    console.log(`[TermHost] removed ${name} (${why})`)
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 63) || "teros"
}

/**
 * Translate an inspected MCA container into the `docker run` of its terminal
 * host. Exported for tests: what is copied is a security property.
 */
export function cloneRunArgs(
  info: InspectedContainer,
  opts: { name: string; labels: Record<string, string> },
): { run: string[]; extraNetworks: string[] } {
  const hc = info.HostConfig ?? {}
  // No healthcheck: the image's probes the MCA server, which a terminal host never runs.
  const run = [
    "run",
    "-d",
    "--name",
    opts.name,
    "--init",
    "--restart",
    "unless-stopped",
    "--no-healthcheck",
  ]
  for (const [k, v] of Object.entries(opts.labels)) run.push("--label", `${k}=${v}`)
  if (hc.Memory) run.push("--memory", `${hc.Memory}b`)
  if (hc.MemorySwap) run.push("--memory-swap", `${hc.MemorySwap}b`)
  if (hc.NanoCpus) run.push("--cpus", String(hc.NanoCpus / 1e9))
  if (hc.PidsLimit && hc.PidsLimit > 0) run.push("--pids-limit", String(hc.PidsLimit))
  for (const opt of hc.SecurityOpt ?? []) run.push("--security-opt", opt)
  for (const cap of hc.CapDrop ?? []) run.push("--cap-drop", cap)
  for (const cap of hc.CapAdd ?? []) run.push("--cap-add", cap)
  for (const host of hc.ExtraHosts ?? []) run.push("--add-host", host)
  for (const dns of hc.Dns ?? []) run.push("--dns", dns)
  for (const m of info.Mounts ?? []) {
    if (m.Type !== "bind" && m.Type !== "volume") continue
    if (SKIPPED_MOUNT_PREFIXES.some((p) => m.Destination.startsWith(p))) continue
    const source = m.Type === "volume" && m.Name ? m.Name : m.Source
    run.push("-v", `${source}:${m.Destination}:${m.RW ? "rw" : "ro"}`)
  }
  for (const e of info.Config?.Env ?? []) {
    if (!SKIPPED_ENV.test(e)) run.push("-e", e)
  }
  const networks = Object.keys(info.NetworkSettings?.Networks ?? {})
  if (networks[0]) run.push("--network", networks[0])
  if (info.Config?.WorkingDir) run.push("-w", info.Config.WorkingDir)
  run.push("--entrypoint", "/usr/local/bin/teros-term-host", info.Config.Image)
  return { run, extraNetworks: networks.slice(1) }
}
