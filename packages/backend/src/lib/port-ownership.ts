/**
 * Port ownership audit — who really holds the backend port.
 *
 * Incident 2026-11-01 08:40 (RAW): a restart left the pm2-managed backend
 * WITHOUT the port and an ORPHAN node process (outside the pm2 tree)
 * listening on it — serving stale code for ~20 minutes while backend-status
 * reported the orphan's pid as if everything were fine.
 *
 * Root cause of the orphan: pm2 runs the tsx wrapper; tsx spawns the real
 * server as a child and forwards SIGTERM to it. If the graceful shutdown
 * does not finish within PM2's kill_timeout (30s), pm2 SIGKILLs the WRAPPER
 * only — the child survives, is re-parented to init, and keeps serving the
 * port with the old code. The next pm2 start then hits EADDRINUSE and
 * crash-loops silently (no EADDRINUSE handler existed).
 *
 * This module answers, from the HOST (the backend process itself):
 *   - which process holds the listen socket of the port (via /proc/net/tcp*
 *     inode -> /proc/<pid>/fd matching — same technique as ss/lsof),
 *   - whether that process descends from the current pm2 wrapper (ppid chain
 *     walk to the pid in PM2's pidfile, plus pm2 env markers as
 *     corroboration),
 *   - the git commit + dirty state of the checkout the process runs from
 *     (cwd of the listener, `git rev-parse HEAD` — optional git binary).
 *
 * Everything is /proc-based: no ps/ss/lsof dependency at runtime, and each
 * piece degrades to null/unknown instead of throwing so a partial audit is
 * still useful.
 */

import { readdirSync, readFileSync, readlinkSync } from "fs"
import { execFile } from "child_process"

// =============================================================================
// TYPES
// =============================================================================

export interface PortOwnerProcess {
  pid: number
  ppid: number
  /** Process command line (argv joined with spaces) — null if unreadable. */
  cmdline: string | null
  /** /proc/<pid>/cwd — null if unreadable. */
  cwd: string | null
  /** True if the process environment carries pm2's own env markers
   * (name, pm_id, pm_pid_path). pm2 injects these into every forked process. */
  pm2Env: boolean
  /** pm2's `name` env var, when present. */
  pm2Name: string | null
  /** pm2's `pm_id` env var, when present. */
  pm2Id: number | null
}

export interface CheckoutInfo {
  /** HEAD commit of the listener's checkout — null if git failed/unavailable. */
  commit: string | null
  /** True when the working tree has uncommitted changes. Null when unknown. */
  dirty: boolean | null
  /** Error message when git could not be consulted. */
  error?: string
}

export interface PortOwnership {
  port: number
  /** Pids holding a LISTEN socket on the port (any local address). Usually
   * exactly one; more than one is itself a red flag (SO_REUSEPORT or a socket
   * inherited by a child). */
  listenerPids: number[]
  /** Detail for each listener pid. */
  listeners: PortOwnerProcess[]
  /** Pid of the current pm2 wrapper for this backend, from PM2's pidfile
   * ($PM2_HOME/pids/<name>-<pm_id>.pid). Null when not running under pm2. */
  pm2WrapperPid: number | null
  /** True when the primary listener descends from the current pm2 wrapper
   * (ppid chain reaches the wrapper pid within 6 hops). False when it does
   * not. Null when the wrapper pid is unknown (not under pm2). */
  listenerDescendsFromPm2: boolean | null
  /** True when the primary listener carries pm2's env markers for THIS app
   * (name + pm_id). Corroborates descent — catches re-parented processes
   * whose ppid chain was broken by a wrapper SIGKILL. */
  listenerHasPm2Env: boolean | null
  /** Git state of the listener's checkout (cwd of the primary listener). */
  checkout: CheckoutInfo | null
  /** Diagnostics from the inode-to-pid scan: how many pids were scanned, how
   * many fd dirs were unreadable, how many individual fd readlinks failed
   * (expected churn), plus the first error messages. Null when not run. */
  pidScan: PidScanDiagnostics | null
  /** Errors from reading /proc/net/tcp(6) themselves — non-empty means the
   * port's listener set could not even be determined (e.g. no /proc access). */
  procNetReadErrors: string[]
  /** Convenience verdict. ok ⇔ exactly one listener AND it descends from the
   * current pm2 wrapper AND it carries the pm2 env markers. Anything else is
   * a broken or suspicious state that callers should surface loudly. */
  ok: boolean
  /** Human-readable explanation of the verdict. */
  reason: string
}

// =============================================================================
// /proc PARSING
// =============================================================================

/** Parse /proc/net/tcp or /proc/net/tcp6 into { localPort, inode } pairs
 * for LISTEN sockets only (state 0A). */
export function parseProcNetTcp(content: string): Array<{ localPort: number; inode: number }> {
  const rows: Array<{ localPort: number; inode: number }> = []
  for (const line of content.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10) continue
    if (cols[3] !== "0A") continue // TCP_LISTEN only
    const localPort = parseInt(cols[1].split(":")[1] ?? "", 16)
    const inode = parseInt(cols[9], 10)
    if (!Number.isNaN(localPort) && localPort > 0 && !Number.isNaN(inode) && inode > 0) {
      rows.push({ localPort, inode })
    }
  }
  return rows
}

/** Find pids whose /proc/<pid>/fd entries include the given socket inodes.
 * Directory entries in /proc/<pid>/fd are the fd NUMBERS; the socket inode
 * lives in the SYMLINK TARGET (/proc/<pid>/fd/<n> -> socket:[<inode>]), so
 * each entry must be readlinked — same technique ss/lsof use. */
export interface PidScanDiagnostics {
  /** Pids actually scanned (fd dir listed). */
  scanned: number
  /** Pids skipped because their fd dir could not be listed (vanished, or
   * unreadable — e.g. running inside a container that cannot see the host's
   * /proc, or another user's processes). */
  fdDirUnreadable: number
  /** Individual fd entries that failed to readlink (fd closed between the
   * dir listing and the readlink — ENOENT). Expected churn on any busy
   * process; must not abort the pid's scan. */
  fdLinksFailed: number
  /** First error messages seen, for reporting (bounded). */
  errors: string[]
}

export function findPidsBySocketInodes(
  inodes: Set<number>,
  listProcDir: (p: string) => string[] = defaultListProcDir,
  readDirNames: (p: string) => string[] = defaultReadDirNames,
  readLink: (p: string) => string = defaultReadLink,
  diagnostics: PidScanDiagnostics | null = null,
): number[] {
  const found: number[] = []
  if (diagnostics) {
    diagnostics.scanned = 0
    diagnostics.fdDirUnreadable = 0
    diagnostics.fdLinksFailed = 0
    diagnostics.errors = []
  }
  if (inodes.size === 0) return found
  for (const pidStr of listProcDir('/proc')) {
    const pid = Number(pidStr)
    if (!Number.isInteger(pid) || pid <= 0) continue
    let fds: string[]
    try {
      fds = readDirNames(`/proc/${pid}/fd`)
    } catch (error) {
      // process vanished between listing and reading, or fd dir unreadable
      // (another user's process, or a container without host /proc visibility)
      // — skip this pid, but count it (no silent catch).
      if (diagnostics) {
        diagnostics.fdDirUnreadable++
        if (diagnostics.errors.length < 5) {
          diagnostics.errors.push(`fd dir /proc/${pid}/fd: ${errorMessage(error)}`)
        }
      }
      continue
    }
    if (diagnostics) diagnostics.scanned++
    for (const fd of fds) {
      let target: string
      try {
        target = readLink(`/proc/${pid}/fd/${fd}`)
      } catch (error) {
        // fd closed between listing the dir and readlinking it (ENOENT) —
        // expected churn on busy processes; skip this fd, NOT the whole pid.
        // (Incident 2026-11-01 ~12:00: one ephemeral fd aborting the whole
        // pid made the audit report "no process is listening" against itself.)
        if (diagnostics) {
          diagnostics.fdLinksFailed++
          if (diagnostics.errors.length < 5) {
            diagnostics.errors.push(`readlink /proc/${pid}/fd/${fd}: ${errorMessage(error)}`)
          }
        }
        continue
      }
      // socket:[<inode>] — "socket:[" is 8 chars, inode ends before ']'
      if (target.startsWith('socket:[')) {
        const inode = Number(target.slice(8, -1))
        if (inodes.has(inode)) {
          found.push(pid)
          break
        }
      }
    }
  }
  return [...new Set(found)].sort((a, b) => a - b)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const defaultListProcDir = (p: string): string[] =>
  readdirSync(p)
    .filter((n) => /^[0-9]+$/.test(n))
    .sort((a, b) => Number(a) - Number(b))

const defaultReadDirNames = (p: string): string[] => readdirSync(p)

const defaultReadLink = (p: string): string => readlinkSync(p)

// =============================================================================
// PROCESS INSPECTION
// =============================================================================

/** Read /proc/<pid>/status and return { pid, ppid } — null if unreadable. */
export function readPidStatus(pid: number): { pid: number; ppid: number } | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    const ppid = Number(/PPid:\s+(\d+)/.exec(status)?.[1] ?? NaN)
    if (Number.isNaN(ppid)) return null
    return { pid, ppid }
  } catch {
    return null
  }
}

/** Read /proc/<pid>/environ and return it as a Map. Empty on failure. */
export function readProcEnviron(pid: number): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8")
    for (const pair of raw.split("\0")) {
      const eq = pair.indexOf("=")
      if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  } catch {
    // unreadable (vanished, or another user's process) — empty map
  }
  return map
}

/** Build a PortOwnerProcess from a pid — every field degrades to null. */
export function inspectProcess(
  pid: number,
  readEnviron: (pid: number) => Map<string, string> = readProcEnviron,
  readCmdline: (pid: number) => string | null = defaultReadCmdline,
  readCwd: (pid: number) => string | null = defaultReadCwd,
): PortOwnerProcess {
  const status = readPidStatus(pid)
  const env = readEnviron(pid)
  const pm2Name = env.get("name") ?? null
  const pm2IdRaw = env.get("pm_id")
  const pm2Id = pm2IdRaw !== undefined && /^\d+$/.test(pm2IdRaw) ? Number(pm2IdRaw) : null
  return {
    pid,
    ppid: status?.ppid ?? -1,
    cmdline: readCmdline(pid),
    cwd: readCwd(pid),
    pm2Env: env.has("name") && env.has("pm_id") && env.has("pm_pid_path"),
    pm2Name,
    pm2Id,
  }
}

const defaultReadCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")
  } catch {
    return null
  }
}

const defaultReadCwd = (pid: number): string | null => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/** True when `pid`'s ppid chain reaches `ancestor` within `maxHops` hops.
 * A re-parented process (ppid 0/1) never matches — that is exactly the
 * orphan signature this exists to catch. */
export function descendsFrom(
  pid: number,
  ancestor: number,
  maxHops = 6,
  readStatus: (pid: number) => { pid: number; ppid: number } | null = readPidStatus,
): boolean {
  if (ancestor <= 0 || pid <= 0) return false
  let current = pid
  for (let hop = 0; hop <= maxHops; hop++) {
    if (current === ancestor) return true
    const status = readStatus(current)
    if (!status) return false
    if (status.ppid <= 1) return false
    current = status.ppid
  }
  return false
}

// =============================================================================
// PM2 IDENTITY
// =============================================================================

/** Pid of the current pm2 wrapper for THIS backend, from PM2's pidfile.
 * PM2 writes the wrapper pid to $PM2_HOME/pids/<name>-<pm_id>.pid and exports
 * pm_pid_path/name/pm_id into the process env — we read our own env (injected
 * by pm2 into the server process) to locate the pidfile, so the check is
 * self-contained. Null when not running under pm2 (no markers in env). */
export function currentPm2WrapperPid(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | null {
  const pidPath = env.pm_pid_path
  const name = env.name
  if (!pidPath || !name) return null
  try {
    const pid = Number(readFile(pidPath).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** True when the process carries pm2 env markers for the given app name. */
export function hasPm2EnvFor(proc: PortOwnerProcess, appName: string): boolean {
  return proc.pm2Env && proc.pm2Name === appName
}

// =============================================================================
// CHECKOUT INFO
// =============================================================================

/** HEAD commit + dirty flag of the listener's checkout (its cwd).
 * `git` binary is optional — failures degrade to null commit with error. */
export async function readCheckoutInfo(
  cwd: string | null,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }> = defaultRunGit,
): Promise<CheckoutInfo> {
  if (!cwd) {
    return { commit: null, dirty: null, error: "listener cwd unreadable" }
  }
  try {
    const commit = await runGit(["rev-parse", "HEAD"], cwd)
    let dirty: boolean | null = null
    try {
      const status = await runGit(["status", "--porcelain"], cwd)
      dirty = status.stdout.trim().length > 0
    } catch {
      dirty = null
    }
    return { commit: commit.stdout.trim() || null, dirty }
  } catch (error) {
    return { commit: null, dirty: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const defaultRunGit = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(String(stderr || error.message)))
      else resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
    })
  })

// =============================================================================
// AUDIT
// =============================================================================

export interface AuditDeps {
  /** Local port to audit (e.g. 10001). */
  port: number
  /** pm2 app name expected to own the port (e.g. "teros-backend"). */
  appName: string
  env?: NodeJS.ProcessEnv
  readFile?: (p: string) => string
  listProcDir?: (p: string) => string[]
  readDirNames?: (p: string) => string[]
  readLink?: (p: string) => string
  readStatus?: (pid: number) => { pid: number; ppid: number } | null
  readEnviron?: (pid: number) => Map<string, string>
  readCmdline?: (pid: number) => string | null
  readCwd?: (pid: number) => string | null
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
}

/**
 * Full port-ownership audit for one port.
 *
 * Reads /proc/net/tcp(6) for LISTEN sockets on the port, maps socket inodes
 * to pids via /proc/<pid>/fd, walks the ppid chain of the primary listener up
 * to the current pm2 wrapper pid, corroborates with pm2 env markers, and
 * reads the git state of the listener's checkout.
 */
export async function auditPortOwnership(deps: AuditDeps): Promise<PortOwnership> {
  const {
    port,
    appName,
    env = process.env,
    readFile = (p) => readFileSync(p, "utf8"),
    listProcDir = defaultListProcDir,
    readDirNames = defaultReadDirNames,
    readLink = defaultReadLink,
    readStatus = readPidStatus,
    readEnviron = readProcEnviron,
    readCmdline = defaultReadCmdline,
    readCwd = defaultReadCwd,
    runGit = defaultRunGit,
  } = deps

  // 1) LISTEN sockets on the port (tcp + tcp6) — read failures are
  // collected explicitly: if both files are unreadable the listener set is
  // UNKNOWN, not empty (AC: no silent catch).
  const inodes = new Set<number>()
  const procNetReadErrors: string[] = []
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const row of parseProcNetTcp(readFile(file))) {
        if (row.localPort === port) inodes.add(row.inode)
      }
    } catch (error) {
      procNetReadErrors.push(`${file}: ${errorMessage(error)}`)
    }
  }

  // 2) Map inodes -> pids (per-fd resilience + countable diagnostics)
  const pidScan: PidScanDiagnostics = { scanned: 0, fdDirUnreadable: 0, fdLinksFailed: 0, errors: [] }
  const listenerPids = findPidsBySocketInodes(inodes, listProcDir, readDirNames, readLink, pidScan)

  // 3) pm2 wrapper pid (pidfile) + descent check on the primary listener
  const pm2WrapperPid = currentPm2WrapperPid(env, readFile)
  const primary = listenerPids[0] ?? null
  const primaryProc = primary !== null ? inspectProcess(primary, readEnviron, readCmdline, readCwd) : null
  const listenerDescendsFromPm2 =
    primary !== null && pm2WrapperPid !== null
      ? descendsFrom(primary, pm2WrapperPid, 6, readStatus)
      : null
  const listenerHasPm2Env = primaryProc ? hasPm2EnvFor(primaryProc, appName) : null

  // 4) Checkout info for the primary listener's cwd
  const checkout = await readCheckoutInfo(primaryProc?.cwd ?? null, runGit)

  // 5) Verdict
  let ok = false
  let reason: string
  if (listenerPids.length === 0 && procNetReadErrors.length > 0) {
    ok = false
    reason = `cannot read /proc/net/tcp(6) (${procNetReadErrors.join("; ")}) — port ownership UNKNOWN, not verified as free`
  } else if (listenerPids.length === 0 && pidScan.scanned === 0 && pidScan.fdDirUnreadable > 0) {
    ok = false
    reason = `no process is listening on :${port} — but ${pidScan.fdDirUnreadable} pids fd dirs were unreadable (running where /proc is not fully visible? e.g. a container): ${pidScan.errors.slice(0, 2).join("; ")}`
  } else if (listenerPids.length === 0) {
    reason = `no process is listening on :${port}`
  } else if (listenerPids.length > 1) {
    reason = `multiple listeners on :${port}: ${listenerPids.join(", ")} — investigate (SO_REUSEPORT or inherited socket)`
  } else if (pm2WrapperPid === null) {
    reason = `not running under pm2 (no pm_pid_path/name env) — cannot verify descent; listener pid ${primary}`
  } else if (!listenerDescendsFromPm2) {
    reason = `listener pid ${primary} does NOT descend from pm2 wrapper ${pm2WrapperPid} — orphan or foreign process holding :${port}`
  } else if (!listenerHasPm2Env) {
    reason = `listener pid ${primary} descends from pm2 but lacks pm2 env markers for ${appName} — suspicious fork`
  } else {
    ok = true
    reason = `listener pid ${primary} descends from pm2 wrapper ${pm2WrapperPid} and carries pm2 env markers for ${appName}`
  }

  return {
    port,
    listenerPids,
    listeners: listenerPids.map((pid) => inspectProcess(pid, readEnviron, readCmdline, readCwd)),
    pm2WrapperPid,
    listenerDescendsFromPm2,
    listenerHasPm2Env,
    checkout,
    pidScan,
    procNetReadErrors,
    ok,
    reason,
  }
}

// =============================================================================
// KILL FOREIGN HOLDERS
// =============================================================================

/**
 * Kill every listener on the port that is NOT part of the current pm2 tree.
 *
 * The pm2 wrapper and its descendants are never touched — if the only
 * listener is a legit pm2 descendant, nothing is killed. Foreign listeners
 * get SIGTERM, then SIGKILL after `killEscalationMs` if they survived.
 *
 * Returns the pids targeted and the ownership snapshot taken BEFORE the
 * kills (callers should re-audit afterwards to confirm the port is free or
 * re-taken by the pm2 tree).
 */
export async function killForeignPortHolders(
  deps: AuditDeps & {
    kill?: (pid: number, signal?: string) => void
    sleep?: (ms: number) => Promise<void>
    killEscalationMs?: number
  },
): Promise<{ killed: number[]; ownership: PortOwnership }> {
  const {
    kill = (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
    sleep = defaultSleep,
    killEscalationMs = 3000,
  } = deps
  const ownership = await auditPortOwnership(deps)
  const killed: number[] = []

  if (ownership.listenerPids.length === 0) return { killed, ownership }

  const wrapper = ownership.pm2WrapperPid
  for (const pid of ownership.listenerPids) {
    // Never kill the wrapper itself or anything descending from it — those
    // are pm2-managed; killing them is pm2's job (restart), not ours.
    if (wrapper !== null && (pid === wrapper || descendsFrom(pid, wrapper, 6, deps.readStatus))) {
      continue
    }
    try {
      kill(pid, "SIGTERM")
      killed.push(pid)
    } catch {
      // already dead — nothing to do
    }
  }
  if (killed.length === 0) return { killed, ownership }

  // Escalate to SIGKILL if they survived SIGTERM
  await sleep(killEscalationMs)
  for (const pid of killed) {
    try {
      kill(pid, "SIGKILL")
    } catch {
      // already dead — SIGTERM was enough
    }
  }
  return { killed, ownership }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))
