/**
 * Terminal domain — PTY-based interactive terminal
 *
 * Actions:
 *   terminal.create      → Open a session (tmux window in the workspace's terminal host)
 *   terminal.input       → Send keystrokes to the PTY (interactive frontend)
 *   terminal.write       → Programmatic write, optionally appending CR (sendEnter)
 *   terminal.read        → Buffered output replay (tail by `lines` or cursor `since`)
 *   terminal.screen      → Rendered screen: rows as the user sees them, cursor, title
 *   terminal.waitFor     → Await a regex match on the output, with timeout
 *   terminal.wait        → Await a state: coding agent's turn over / ready, quiet, screen text, exit
 *   terminal.reveal      → Ask the person's Terminal window to show a session
 *   terminal.resize      → Resize the PTY (cols/rows)
 *   terminal.destroy     → Kill the PTY session (the only way a session ends besides its shell exiting)
 *   terminal.update      → Rename a session (`pinned` is accepted and ignored)
 *   terminal.subscribe   → Subscribe session to terminal output events (legacy JSON stream)
 *   terminal.unsubscribe → Unsubscribe session from terminal output events
 *   terminal.watch       → Subscribe to a workspace's session list (live status, agent state)
 *   terminal.unwatch     → Stop watching a workspace's session list
 *   terminal.ticket      → Single-use ticket for the /ws/terminal data plane
 *   terminal.list        → List live PTY sessions (workspace-filtered)
 *   terminal.status      → Detailed status of one PTY session (`wake: true` wakes it first)
 *   terminal.takeWheel   → A person takes the wheel (drives; the agent becomes the copilot)
 *   terminal.giveBack    → The person at the wheel gives it back to the agent (optional note)
 *   terminal.yield       → In a conflict (two people typing), cede the wheel to the other one
 *
 * Sessions live in the workspace's terminal host (services/terminal/term-host.ts:
 * a tmux server in a `teros-term-*` container cloned from the bash app's), so
 * they outlive the browser tab and the backend. They are never ended for
 * being idle: they sleep (pty-manager.ts — frozen host, then saved and the
 * container removed) and wake on use. Every action that uses a session (input,
 * write, read, screen, wait, waitFor, create of an existing id, a viewer
 * attaching on /ws/terminal) wakes it first and says so (`woke`); listing and
 * status don't. Waking from sleep is wakeSession() below: same terminalId and
 * cwd, the old scrollback printed dimmed, Claude Code resumed on its
 * conversation. Images without the terminal host fall back to the legacy
 * one-process-per-session `docker exec -it` PTY (no sleep).
 *
 * Authz model (workspace is sovereign): a PTY belongs to the workspace of the
 * app that spawned it, and touching one — opening, typing, but also reading,
 * watching or resizing it — requires workspace WRITE access (owner, admin or
 * write member). A terminal is a root shell whose screen shows secrets, so a
 * read-role member gets nothing: no list entry, no output, no resize
 * (decision D6, terminal-gem report). Shared with /ws/terminal via
 * services/terminal/terminal-access.ts.
 *
 * Host PTYs were a separate tier keyed on mca.teros.admin.bash apps. That MCA
 * was retired on 2026-10-19 (replaced by Teros Remote — task_674f6a80d7618a49),
 * so no new host session can be created; the isHost guards below stay as
 * fail-closed protection for any host session still alive in memory.
 *
 * @todo nira - 2026-10-19: host-PTY creation path removed with mca.teros.admin.bash.
 * If the Terminal window should regain a host-shell mode, re-key it to a Teros
 * Remote device (needs PTY streaming over the tunnel — not in the remote spec yet).
 * Once no live host sessions can exist, the isHost guards + mayUseHostPty can
 * be deleted too.
 *
 * Shared sessions (the terminal crew): people and agents can type into the
 * same session, one at the wheel (services/terminal/driver-lease.ts). A person
 * typing drives; an agent's write is refused (WHEEL_HELD) while a person
 * drives and typed or took the wheel within the last 60 s — its terminal.wait
 * returns early when the driver changes, and the note left with
 * terminal.giveBack reaches it once (`handedBack` on its next wait, read or
 * screen). Every session carries `driver`, `watchers` (people with it open,
 * agents waiting on it) and `conflict` (two people typing within 2 s).
 */

import {
  type AccessAction,
  isSpace,
  type Principal,
  type Space,
  type TerminalDriver,
  type TerminalWatcher,
  type WsHandlerContext,
} from "@teros/shared"
import { type LaunchOptions, appendLaunchArgs, parseLaunchOptions } from "../../../services/terminal/launch-options"
import { execSync } from "child_process"
import { randomBytes } from "crypto"
import type { Db } from "mongodb"
import { canAccessWorkspace, canWriteWorkspace } from "../../../auth/workspace-access"
import { COLLECTIONS, collection } from "../../../db"
import type { McaManager } from "../../../services/mca-manager"
import type { McaService } from "../../../services/mca-service"
import type { ProviderService } from "../../../services/provider-service"
import type {
  PtyManager,
  ReadResult,
  SessionInfo,
  SessionStatus,
  SleepRecord,
  WaitForResult,
  WakeResult,
} from "../../../services/pty-manager"
import type { PubSubService } from "../../../services/pubsub-service"
import { agentProviderEnv } from "../../../services/terminal/agent-provider-key"
import { detectBlocked, detectMenu } from "../../../services/terminal/agent-heuristics"
import {
  AGENT_LAUNCH_LINES,
  AGENT_TITLES,
  claudeApproveKeyScript,
  claudeSessionPrepScript,
  claudeHooksSetupScript,
  claudeOnboardingScript,
  claudeResumeLine,
  isPreset,
  resumeHistoryScript,
  resumePlan,
  resumeWindowCommand,
  type TerminalPreset,
  wakeCwdOf,
} from "../../../services/terminal/agent-hooks"
import { isWaitUntil, makeWaitCheck, type WaitOutcome } from "../../../services/terminal/agent-wait"
import { CrewIdentities } from "../../../services/terminal/crew-identity"
import { LeaseError } from "../../../services/terminal/driver-lease"
import { TerminalSleepStore } from "../../../services/terminal/sleep-store"
import type { TerminalStreamServer } from "../../../services/terminal/stream-server"
import { hostPersonOf, spaceOfSession, type TermHost } from "../../../services/terminal/term-host"
import {
  checkTerminalAccess,
  mayReachSession,
  mayUseHostPty as mayUseHostPtyFor,
  terminalPrincipal,
} from "../../../services/terminal/terminal-access"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import { HandlerError } from "../../../ws-framework/WsRouter"

const MAX_TERMINAL_ID = 128

/** terminal.wait: longest single wait (the MCA's tool call must answer within 120 s). */
const MAX_STATE_WAIT_MS = 100_000

export interface TerminalDomainDeps {
  pubSubService: PubSubService
  ptyManager: PtyManager
  /** Who is who on the seat (tests inject a fake). */
  identities?: Pick<CrewIdentities, "human" | "agent">
  mcaService: McaService
  mcaManager: McaManager
  db: Db
  /** /ws/terminal data plane (tickets, viewer counts). Absent in tests and on stacks without it. */
  stream?: TerminalStreamServer | null
  /** Shell exec override (test-only). Production default wraps execSync. */
  exec?: (cmd: string) => string
  /** Reads the user's Teros providers ("Use Teros" for coding agents). */
  providerService?: ProviderService | null
}

/** Keys and codes are single tokens: no whitespace, no control characters. */
function hasSpaceOrControl(value: string): boolean {
  for (const ch of value) {
    const c = ch.charCodeAt(0)
    if (c <= 0x20 || c === 0x7f || /\s/.test(ch)) return true
  }
  return false
}

/** A question or menu on screen waiting for someone (permission prompt, dialog), else null. */
function screenQuestion(lines: string[]): string | null {
  return detectMenu(lines) ?? detectBlocked(lines)
}

/** Text pasted must not close the paste early (or open a nested one). */
function stripPasteMarkers(text: string): string {
  return text.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "")
}

/**
 * The call came through the MCA bridge (admin_request: synthetic `mca:` session
 * whose userId is the workspace owner; domain_request: ctx.actor set). Its
 * userId does not identify the human behind the call, so it never gets a host shell.
 */
function isBridgeCall(ctx: WsHandlerContext): boolean {
  return ctx.actor !== undefined || ctx.sessionId.startsWith("mca:")
}

/** Identity recorded as the typist / creator for a bridge call. */
function agentId(ctx: WsHandlerContext): string {
  return `agent:${ctx.sessionId.startsWith("mca:") ? ctx.sessionId.slice(4) : "domain"}`
}

function requestedSpace(value: unknown, bridge: boolean): Space {
  if (value === undefined || value === null) return bridge ? "shared" : "personal"
  if (!isSpace(value)) throw new HandlerError("INVALID_SPACE", 'space must be "personal" or "shared"')
  if (bridge && value === "personal")
    throw new HandlerError(
      "INVALID_SPACE",
      "A terminal an agent opens is always shared: a personal terminal belongs to a person",
    )
  return value
}

/** A driver's identity, to tell a change of hands from a refresh. */
function driverKey(d: TerminalDriver | null | undefined): string {
  return d ? `${d.kind}:${d.id ?? ""}` : ""
}

/**
 * Ensure the MCA bash container is running by executing a dummy command,
 * then return the actual container name via docker ps.
 */
async function ensureContainerRunning(
  mcaManager: McaManager,
  appId: string,
  userId: string,
  workspaceId: string,
  exec: (cmd: string) => string,
): Promise<string> {
  const toolName = "bash_bash"
  // Execute a no-op to force the container to start
  await mcaManager.executeTool(
    toolName,
    { command: "true", description: "warmup" },
    // workspaceId: tool calls are signed per workspace; without it the bash MCA
    // rejects the (unsigned) warmup.
    { appId, userId, workspaceId },
  )

  // Find the container by appId suffix
  const suffix = appId.replace("app_", "").slice(-8)
  const pattern = `mca-teros-bash-${suffix}`
  try {
    const result = exec(`docker ps --filter "name=${pattern}" --format "{{.Names}}"`).trim()
    if (result) return result
  } catch {
    /* intentional: docker ps returned nothing — container not found, fall through to throw */
  }
  throw new Error(`Container ${pattern} not found after warmup`)
}

export function register(router: WsRouter, deps: TerminalDomainDeps): void {
  const { pubSubService, ptyManager, mcaService, mcaManager, db } = deps
  const stream = deps.stream ?? null
  // MCA containers may run on a remote execution host (TWO-HOST-SEPARATION-PLAN
  // phase 3): TERMINAL_DOCKER_HOST points the docker CLI there. Scoped env,
  // not a global DOCKER_HOST — see pty-manager.ts for the same pattern.
  const exec =
    deps.exec ??
    ((cmd: string) =>
      execSync(cmd, {
        encoding: "utf8",
        env: process.env.TERMINAL_DOCKER_HOST
          ? { ...process.env, DOCKER_HOST: process.env.TERMINAL_DOCKER_HOST }
          : process.env,
      }))

  const identities = deps.identities ?? new CrewIdentities(db)

  /** A session's list entry plus who is watching it (people with it open, agents waiting on it). */
  function describe(
    session: SessionInfo,
  ): SessionInfo & { viewers: number; watchers: TerminalWatcher[] } {
    return {
      ...session,
      viewers: stream?.viewerCount(session.terminalId) ?? 0,
      watchers:
        stream?.watchers(session.terminalId) ??
        ptyManager.agentWatchers?.(session.terminalId) ??
        [],
    }
  }

  // Session list changes → the workspace's watchers (terminal.watch) and the
  // session's live viewers (/ws/terminal).
  ptyManager.onChange?.((terminalId, workspaceId, reason) => {
    if (reason === "flood_on" || reason === "flood_off") {
      stream?.notifyFlood(terminalId, reason === "flood_on")
      return
    }
    // tmux paused our client (>5 s behind): output was dropped, resync viewers.
    if (reason === "resync") {
      stream?.resync(terminalId)
      return
    }
    const session = ptyManager.describe(terminalId)
    if (reason === "watchable" || reason === "control" || reason === "exit")
      revokeOutput(terminalId, workspaceId, session)
    if (workspaceId) announce(terminalId, workspaceId, reason, session)
    if (reason === "exit") stream?.notifyExit(terminalId, 0)
    else stream?.notifyState(terminalId, session)
  })

  const privateOpeners = new Map<string, string>()
  const outputSubscribers = new Map<string, Map<string, Principal>>()

  async function subscribeOutput(ctx: WsHandlerContext, terminalId: string): Promise<void> {
    const workspaceId = ptyManager.ownerOf(terminalId)
    if (!workspaceId) return
    const principal = await callerPrincipal(ctx, workspaceId)
    const session = ptyManager.describe?.(terminalId)
    if (session && !mayReachSession(session, workspaceId, principal)) return
    const subscribers = outputSubscribers.get(terminalId) ?? new Map<string, Principal>()
    subscribers.set(ctx.sessionId, principal)
    outputSubscribers.set(terminalId, subscribers)
    pubSubService.subscribeSession(ctx.sessionId, `terminal:${terminalId}`)
  }

  function revokeOutput(
    terminalId: string,
    workspaceId: string | undefined,
    session: SessionInfo | null,
  ): void {
    const subscribers = outputSubscribers.get(terminalId)
    if (!subscribers) return
    for (const [sessionId, principal] of subscribers) {
      if (session && workspaceId && mayReachSession(session, workspaceId, principal)) continue
      subscribers.delete(sessionId)
      pubSubService.unsubscribeSession(sessionId, `terminal:${terminalId}`)
    }
    if (subscribers.size === 0) outputSubscribers.delete(terminalId)
  }

  async function callerPrincipal(ctx: WsHandlerContext, workspaceId: string): Promise<Principal> {
    const bridge = isBridgeCall(ctx)
    return terminalPrincipal(
      db,
      { userId: ctx.userId, bridge, workspaceId: bridge ? await bridgeWorkspace(ctx) : null },
      workspaceId,
    )
  }

  function personalOwnerOf(session: SessionInfo | null): string | null {
    return session ? hostPersonOf(session) : null
  }

  function sessionsTopic(workspaceId: string, opener?: string | null): string {
    return opener ? `terminals:${workspaceId}:${opener}` : `terminals:${workspaceId}`
  }

  function announce(
    terminalId: string,
    workspaceId: string,
    reason: string,
    session: SessionInfo | null,
  ): void {
    const send = (topic: string, shown: SessionInfo | null, why = reason) =>
      pubSubService.broadcastToTopic?.(topic, {
        type: "terminal_sessions",
        workspaceId,
        terminalId,
        reason: why,
        session: shown ? describe(shown) : null,
      })
    const owner = personalOwnerOf(session)
    const opener = owner && !session?.watchable ? owner : null
    const wasPrivateOf = privateOpeners.get(terminalId) ?? null
    if (opener) privateOpeners.set(terminalId, opener)
    else privateOpeners.delete(terminalId)
    if (!session) {
      send(sessionsTopic(workspaceId, wasPrivateOf), null)
      return
    }
    if (opener && !wasPrivateOf && reason === "watchable") {
      send(sessionsTopic(workspaceId), null, "unwatchable")
      stream?.dropViewers(terminalId, (userId) => userId === opener)
    }
    send(sessionsTopic(workspaceId, opener), session)
  }

  async function bridgeWorkspace(ctx: WsHandlerContext): Promise<string | null> {
    if (ctx.actor?.workspaceId) return ctx.actor.workspaceId
    const appId =
      ctx.actor?.appId ?? (ctx.sessionId.startsWith("mca:") ? ctx.sessionId.slice(4) : "")
    if (!appId) return null
    const app = await mcaService.getApp(appId).catch(() => null)
    return app?.ownerId ?? null
  }

  /** May this caller hold a host shell? System admin, on their own session. */
  function mayUseHostPty(ctx: WsHandlerContext): Promise<boolean> {
    return mayUseHostPtyFor(db, { userId: ctx.userId, bridge: isBridgeCall(ctx) })
  }

  /**
   * Verify the caller may act on an existing PTY (terminal-access.ts: workspace
   * write access; host sessions additionally a system admin). Fail-closed: a
   * session without recorded owner is denied. No-ops when there is no session —
   * callers decide how to handle absence.
   */
  async function assertTerminalAccess(
    ctx: WsHandlerContext,
    terminalId: string,
    action: AccessAction,
  ): Promise<void> {
    const bridge = isBridgeCall(ctx)
    const denial = await checkTerminalAccess(
      db,
      ptyManager,
      { userId: ctx.userId, bridge, workspaceId: bridge ? await bridgeWorkspace(ctx) : null },
      terminalId,
      action,
    )
    if (denial === null || denial === "TERMINAL_NOT_FOUND") return
    if (denial === "FORBIDDEN_WORKSPACE_ROLE") {
      throw new HandlerError(
        "FORBIDDEN_WORKSPACE_ROLE",
        "Write access to the workspace is required",
      )
    }
    if (denial === "TERMINAL_VIEW_ONLY")
      throw new HandlerError(
        "TERMINAL_VIEW_ONLY",
        "This is someone's personal terminal: they let the workspace watch it, and only they can type in it or change it.",
      )
    throw new HandlerError("FORBIDDEN_TERMINAL", `No access to terminal ${terminalId}`)
  }

  /**
   * Authz + existence gate for the programmatic actions (read/write/waitFor/status):
   * the caller must have access to the workspace that owns the PTY, and the
   * PTY must be live. Programmatic consumers poll and branch on the result, so
   * a missing session is a hard error (TERMINAL_NOT_FOUND) — unlike the
   * interactive actions, which keep the manager's silent no-op for UX reasons.
   * Authz runs before the existence check so a caller can't probe terminalIds.
   */
  async function requireSession(
    ctx: WsHandlerContext,
    terminalId: string,
    action: AccessAction,
  ): Promise<void> {
    await assertTerminalAccess(ctx, terminalId, action)
    if (!ptyManager.has(terminalId)) {
      throw new HandlerError("TERMINAL_NOT_FOUND", `Terminal ${terminalId} not found`)
    }
  }

  /**
   * Bring a session back to life before it is used (frozen host → unpause;
   * asleep → wakeSession). The result says what it woke from, null when it
   * was awake. A session that cannot be woken is TERMINAL_WAKE_FAILED.
   */
  async function refuseWakeToWatchers(ctx: WsHandlerContext, terminalId: string): Promise<void> {
    const lifecycle = ptyManager.describe?.(terminalId)?.lifecycle
    if (!lifecycle || lifecycle === "awake") return
    const bridge = isBridgeCall(ctx)
    const denial = await checkTerminalAccess(
      db,
      ptyManager,
      { userId: ctx.userId, bridge, workspaceId: bridge ? await bridgeWorkspace(ctx) : null },
      terminalId,
      "use",
    )
    if (denial === "TERMINAL_VIEW_ONLY")
      throw new HandlerError(
        "TERMINAL_ASLEEP",
        "This terminal is asleep: only its person can wake it",
      )
  }

  async function wake(ctx: WsHandlerContext, terminalId: string): Promise<WakeResult | null> {
    await refuseWakeToWatchers(ctx, terminalId)
    try {
      return (await ptyManager.ensureAwake?.(terminalId, { userId: ctx.userId })) ?? null
    } catch (err) {
      throw new HandlerError(
        "TERMINAL_WAKE_FAILED",
        `Could not wake terminal ${terminalId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** requireSession + wake: for the actions that use the session (write, read, screen, waits). Results carry `woke` only when it did. */
  async function requireAwake(
    ctx: WsHandlerContext,
    terminalId: string,
    action: AccessAction,
  ): Promise<{ woke: WakeResult["from"] | null }> {
    await requireSession(ctx, terminalId, action)
    const woke = await wake(ctx, terminalId)
    return { woke: woke?.from ?? null }
  }

  async function workspaceOwner(workspaceId: string): Promise<string> {
    const workspace = await collection(db, COLLECTIONS.workspaces).findOne({ workspaceId })
    return String(workspace?.ownerId ?? "")
  }

  async function hostFor(
    appId: string,
    workspaceId: string,
    warmAs: string,
    person: string | null,
  ): Promise<TermHost> {
    const termHosts = ptyManager.termHostManager
    if (!termHosts) throw new Error("terminal hosts are not available")
    const running = await termHosts.running(appId, person)
    if (running) return running
    const seedSharedHome = person !== null && person === (await workspaceOwner(workspaceId))
    return termHosts.ensure(
      appId,
      workspaceId,
      () => ensureContainerRunning(mcaManager, appId, warmAs, workspaceId, exec),
      person ? { person, seedSharedHome } : undefined,
    )
  }

  async function agentClaudeEnv(
    host: TermHost,
    workspaceId: string,
    cwd: string,
  ): Promise<Record<string, string> | undefined> {
    const env = await agentProviderEnv(deps.providerService, await workspaceOwner(workspaceId))
    if (!env) return undefined
    const scripts = [claudeSessionPrepScript(cwd)]
    if (env.ANTHROPIC_API_KEY) scripts.push(claudeApproveKeyScript(env.ANTHROPIC_API_KEY))
    const prep = await host
      .runScript(scripts.join("\n"))
      .catch((err: unknown) => ({ code: 1, stderr: String(err) }))
    if (prep.code !== 0) console.warn(`[terminal] claude session prep failed: ${prep.stderr.trim()}`)
    return env
  }

  /**
   * Wake a sleeping session (PtyManager's SessionWaker): the workspace's host
   * (started when it was hibernated), what ran in it again with the same
   * credentials as at create — Claude Code on its conversation —, the old
   * scrollback printed dimmed in the same cwd. `userId`: whoever wakes it (the
   * bash app warmup is signed for them); credentials stay the creator's.
   */
  async function wakeSession(record: SleepRecord, userId: string): Promise<void> {
    const termHosts = ptyManager.termHostManager
    if (!termHosts) throw new Error("terminal hosts are not available")
    const app = await mcaService.getApp(record.appId)
    if (!app || app.ownerId !== record.workspaceId)
      throw new Error(`its Bash app ${record.appId} is gone`)
    const host = await hostFor(record.appId, record.workspaceId, userId, hostPersonOf(record))
    const plan = resumePlan(record)
    const bridge = record.createdBy.startsWith("agent:")
    const file = `/tmp/teros-resume-${randomBytes(6).toString("hex")}`
    const prep = await host.runScript(resumeHistoryScript(file, record.history, record.cwd || "/"))
    // The single boot cwd (Pablo, 2-nov): a runner session always comes back
    // in /workspace — never in the dir Claude had cd'ed into before sleeping
    // (that both breaks `--resume` and can hit an untrusted dir's trust
    // dialog, fb_53dc509e82f7b0c0). A person's session keeps its own cwd.
    const cwd = wakeCwdOf(bridge, plan.agent, record.cwd, prep.stdout.includes("cwd-ok"))
    if (plan.agent === "claude") {
      const setup = await host.runScript(
        `${claudeHooksSetupScript()}
${claudeOnboardingScript(bridge ? { trustDir: cwd } : {})}`,
      )
      if (setup.code !== 0)
        console.warn(`[terminal.wake] claude hooks setup failed: ${setup.stderr.trim()}`)
    }
    const env =
      bridge && record.kind === "claude" ? await agentClaudeEnv(host, record.workspaceId, cwd) : undefined
    await ptyManager.createInHost(
      host,
      record.terminalId,
      record.cols,
      record.rows,
      record.workspaceId,
      {
        title: record.title,
        kind: record.kind,
        createdBy: record.createdBy,
        appId: record.appId,
        auth: record.auth,
        space: spaceOfSession(record),
      },
      {
        cwd,
        env,
        command: resumeWindowCommand(file, plan.notRestored),
        resumed: {
          agent: plan.agent,
          notRestored: plan.notRestored,
          message: plan.message,
          cwd,
          sameDir: !record.cwd || cwd === record.cwd,
        },
      },
    )
    const launch =
      plan.agent === "claude"
        ? claudeResumeLine(record.agentSession, bridge ? "fresh" : "continue")
        : plan.launch
    if (launch)
      ptyManager.write(
        record.terminalId,
        `${launch}
`,
      )
  }

  if (ptyManager.termHostManager) ptyManager.useSleepStore?.(new TerminalSleepStore(db))
  ptyManager.useWaker?.((record, by) => wakeSession(record, by.userId))

  /**
   * Shared-session etiquette (the wheel): an agent types only when it may
   * drive — nobody, an agent or an idle person at the wheel — else
   * WHEEL_HELD with who holds it; a person typing drives (or is in conflict
   * with the person driving) — EXCEPT when an agent holds the wheel: viewing
   * a terminal is read-only then, and the person's keys are refused until
   * they take the wheel (the button). `hint`: the agentId the MCA says it
   * acts for.
   */
  async function beforeInput(
    ctx: WsHandlerContext,
    terminalId: string,
    hint?: unknown,
  ): Promise<void> {
    if (isBridgeCall(ctx)) {
      const who = await identities.agent(ctx, hint)
      const held = ptyManager.agentMayWrite?.(terminalId, who)
      if (held) throw new HandlerError("WHEEL_HELD", held.message)
      // The manager announces every agent write (reason "input": watchers and viewers).
      ptyManager.noteInput?.(terminalId, { kind: "agent", id: agentId(ctx), name: who.name }, who)
      return
    }
    // A person's keys reach the pane only when they hold the wheel (or nobody
    // does): an agent at the wheel keeps it until the person takes it.
    const driver = ptyManager.driver?.(terminalId)
    if (driver?.kind === "agent") {
      throw new HandlerError(
        "WHEEL_HELD",
        `${driver.name || "The agent"} is typing in this session: your keys were not sent. Switch "Agent off" to type.`,
      )
    }
    const who = await identities.human(ctx.userId)
    if (
      ptyManager.noteInput?.(terminalId, { kind: "human", id: ctx.userId, name: who.name }, who)
    ) {
      stream?.notifyState(terminalId, ptyManager.describe(terminalId))
    }
  }

  /** Put the calling agent at the wheel of a session it just opened. */
  async function seatAgent(ctx: WsHandlerContext, terminalId: string, hint: unknown) {
    const who = await identities.agent(ctx, hint)
    ptyManager.noteInput?.(terminalId, { kind: "agent", id: agentId(ctx), name: who.name }, who)
  }

  /** What an agent learns with each wait/read/screen: who drives, and a give-back note once. */
  async function crewNews(
    ctx: WsHandlerContext,
    terminalId: string,
    hint: unknown,
  ): Promise<{ driver?: TerminalDriver; handedBack?: unknown }> {
    if (!isBridgeCall(ctx)) return {}
    const driver = ptyManager.driver?.(terminalId)
    if (!driver) return {}
    const me = await identities.agent(ctx, hint)
    const handedBack = ptyManager.takeHandedBack?.(terminalId, me.id) ?? null
    return { driver, ...(handedBack ? { handedBack } : {}) }
  }

  /**
   * terminal.create
   * Opens a session. Workspace apps: a window of the workspace's tmux server
   * (terminal host, created on first use as a clone of the warmed bash MCA
   * container); legacy `docker exec -it` PTY when the image has no terminal
   * host. (The host mode that used to exist for the retired mca.teros.admin.bash
   * was removed on 2026-10-19 — see the @todo in the file header.)
   *
   * Options: title, kind, cwd, command (typed into the fresh shell), preset ('claude' installs the
   * agent-state hooks and starts Claude Code), subscribe (default true: also
   * stream output as JSON terminal_output events on the main WS — the
   * /ws/terminal data plane doesn't need it). `pinned` is accepted and ignored
   * (every session is kept until closed). An existing terminalId is reused —
   * and woken when it sleeps (`woke`).
   */
  /**
   * terminal.create calls in flight, by terminalId. A client that timed out
   * and retries with the same id (or a second tab) joins the first call and
   * gets `reused: true` instead of a second session — or, before this, a
   * second launch line typed into the first one.
   */
  const creating = new Map<string, Promise<unknown>>()

  router.register("terminal.create", async (ctx: WsHandlerContext, rawData: unknown) => {
    const id = (rawData as { terminalId?: unknown } | null)?.terminalId
    const inflight = typeof id === "string" ? creating.get(id) : undefined
    // Whatever the first call's outcome, this one then takes the normal path:
    // the reuse branch (with its own authz) when it worked, a fresh try when not.
    if (inflight) await inflight.catch(() => undefined)
    if (typeof id !== "string" || creating.has(id)) return createSession(ctx, rawData)
    const p = createSession(ctx, rawData)
    creating.set(id, p)
    try {
      return await p
    } finally {
      creating.delete(id)
    }
  })

  async function createSession(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as {
      terminalId: string
      appId: string
      mcaId?: string | null
      cols?: number
      rows?: number
      /** Deprecated, ignored. */
      pinned?: boolean
      title?: string
      kind?: string
      cwd?: string
      command?: string
      preset?: TerminalPreset
      subscribe?: boolean
      reveal?: boolean
      space?: unknown
    }

    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (typeof data.terminalId !== "string" || data.terminalId.length > MAX_TERMINAL_ID) {
      throw new HandlerError(
        "INVALID_TERMINAL_ID",
        `terminalId must be a string of at most ${MAX_TERMINAL_ID} characters`,
      )
    }
    if (!data.appId) throw new HandlerError("MISSING_APP_ID", "appId is required")
    if (data.preset !== undefined && !isPreset(data.preset)) {
      throw new HandlerError("INVALID_PRESET", 'preset must be "shell" or "claude"')
    }
    const space = requestedSpace(data.space, isBridgeCall(ctx))

    // Verify user has access to the app (apps are workspace-owned:
    // ownerType 'workspace', ownerId === workspaceId)
    const app = await mcaService.getApp(data.appId)
    if (!app) throw new HandlerError("APP_NOT_FOUND", `App ${data.appId} not found`)
    const workspaceId = app.ownerId
    if (
      !(await canAccessWorkspace(db, ctx.userId, workspaceId)) ||
      (isBridgeCall(ctx) && (await bridgeWorkspace(ctx)) !== workspaceId)
    ) {
      throw new HandlerError("FORBIDDEN_WORKSPACE", `No access to workspace ${workspaceId}`)
    }
    if (!(await canWriteWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError(
        "FORBIDDEN_WORKSPACE_ROLE",
        "Write access to the workspace is required",
      )
    }
    if (!isBridgeCall(ctx) && mcaService.isAppVisibleTo?.(app, ctx.userId) === false) {
      throw new HandlerError(
        "FORBIDDEN_APP",
        "This Bash app is another member's personal app: ask them to share it with the workspace",
      )
    }
    if (!isBridgeCall(ctx) && space === "shared" && app.scope === "personal") {
      throw new HandlerError(
        "PERSONAL_APP",
        "A shared terminal runs in the workspace's machine, and that needs a shared Bash app. This Bash app is personal: switch it to shared in My Apps → Settings, or open a personal terminal.",
      )
    }

    // The mode (host vs container) is the app's, never the client's: the
    // frontend echoes the app's mcaId (or null when it was given an appId),
    // anything else is refused outright.
    if (data.mcaId && data.mcaId !== app.mcaId) {
      throw new HandlerError("MCA_MISMATCH", `mcaId does not match app ${data.appId}`)
    }

    const cols = data.cols ?? 120
    const rows = data.rows ?? 45
    const topic = `terminal:${data.terminalId}`
    const subscribe = data.subscribe !== false

    // Sessions of terminal hosts that survived a backend restart must be known
    // before deciding whether this id is new.
    await ptyManager.whenAdopted?.()

    // If a PTY session already exists for this terminalId, just subscribe and return.
    // This handles the case of multiple browser tabs sharing the same window — they
    // all subscribe to the same topic and see the same output without spawning a new PTY.
    // The existing PTY must belong to the same workspace as the requested app:
    // otherwise a caller could attach to a foreign terminal via its terminalId.
    // A host PTY additionally needs a system admin, whatever app is passed.
    if (ptyManager.has(data.terminalId)) {
      if (ptyManager.ownerOf(data.terminalId) !== workspaceId) {
        throw new HandlerError("FORBIDDEN_TERMINAL", `No access to terminal ${data.terminalId}`)
      }
      await assertTerminalAccess(ctx, data.terminalId, "see")
      const reusedHost = ptyManager.isHost(data.terminalId)
      if (reusedHost && !(await mayUseHostPty(ctx))) {
        throw new HandlerError("FORBIDDEN_TERMINAL", `No access to terminal ${data.terminalId}`)
      }
      const woke = await wake(ctx, data.terminalId)
      if (subscribe) await subscribeOutput(ctx, data.terminalId)
      if (data.reveal) ptyManager.reveal?.(data.terminalId)
      console.log(
        `✅ [terminal.create] terminal=${data.terminalId} user=${ctx.userId} host=${reusedHost} — reusing existing PTY session${woke ? ` (woke from ${woke.from})` : ""}`,
      )
      return {
        terminalId: data.terminalId,
        cols,
        rows,
        reused: true,
        ...(woke ? { woke: woke.from } : {}),
      }
    }

    // (The host-PTY branch for mca.teros.admin.bash apps was removed on
    // 2026-10-19 — see the @todo in the file header.)

    const bridge = isBridgeCall(ctx)
    const preset: TerminalPreset = data.preset ?? "shell"
    // Launch options (CCR-REQ-2/3): bridge callers only — extra TEROS_* env and
    // extra args for the coding agent's launch line (the Claude Code runner).
    let launchOptions: LaunchOptions | null = null
    if (bridge) {
      try {
        launchOptions = parseLaunchOptions((rawData as { launch?: unknown }).launch)
      } catch (err) {
        throw new HandlerError("INVALID_LAUNCH", err instanceof Error ? err.message : String(err))
      }
    }
    const termHosts = ptyManager.termHostManager ?? null
    if (termHosts) {
      try {
        // Reuse the running host; only a first session pays the bash warmup
        // (its container is the template the host is cloned from).
        const host = await hostFor(
          data.appId,
          workspaceId,
          ctx.userId,
          space === "personal" ? ctx.userId : null,
        )
        const cwd = data.cwd ?? "/workspace"
        if (preset === "claude") {
          const setup = await host.runScript(
            `${claudeHooksSetupScript()}\n${claudeOnboardingScript(bridge ? { trustDir: cwd } : {})}`,
          )
          if (setup.code !== 0)
            console.warn(`[terminal.create] claude hooks setup failed: ${setup.stderr.trim()}`)
        }
        const env =
          bridge && preset === "claude" ? await agentClaudeEnv(host, workspaceId, cwd) : undefined
        await ptyManager.createInHost(
          host,
          data.terminalId,
          cols,
          rows,
          workspaceId,
          {
            title: (data.title ?? (preset === "shell" ? "" : AGENT_TITLES[preset])).slice(0, 200),
            kind:
              preset === "shell"
                ? (data.kind ?? (bridge ? "agent" : "shell")).slice(0, 32)
                : preset,
            createdBy: bridge ? agentId(ctx) : ctx.userId,
            appId: data.appId,
            auth: env ? "API key" : "",
            space,
          },
          {
            cwd,
            env: launchOptions?.env ? { ...(env ?? {}), ...launchOptions.env } : env,
          },
        )
        const launch =
          preset === "shell"
            ? data.command
            : appendLaunchArgs(AGENT_LAUNCH_LINES[preset], launchOptions?.args ?? [])
        if (launch) ptyManager.write(data.terminalId, `${launch}\r`)
        // A session an agent opens is the agent's to drive from the start.
        if (bridge)
          await seatAgent(ctx, data.terminalId, (rawData as { agentId?: unknown }).agentId)
        if (subscribe) await subscribeOutput(ctx, data.terminalId)
        if (data.reveal) ptyManager.reveal?.(data.terminalId)
        console.log(
          `✅ [terminal.create] terminal=${data.terminalId} user=${ctx.userId} host=${host.container} preset=${preset} space=${space}`,
        )
        return { terminalId: data.terminalId, cols, rows, persistent: true }
      } catch (err) {
        // Images without the terminal host (no tmux / teros-term-host) keep
        // working on the legacy PTY below.
        console.warn(
          `[terminal.create] terminal host unavailable, legacy PTY: ${err instanceof Error ? err.message : String(err)}`,
        )
        if (!bridge)
          throw new HandlerError(
            "TERMINAL_HOST_UNAVAILABLE",
            `Could not start your terminal machine: ${err instanceof Error ? err.message : String(err)}`,
          )
      }
    }

    // Docker mode: ensure container is running and get its real name
    const containerId = await ensureContainerRunning(
      mcaManager,
      data.appId,
      ctx.userId,
      workspaceId,
      exec,
    )

    // Create the PTY (recording the owning workspace for authz on later actions),
    // then subscribe — subscribing first would leave a dangling subscription if
    // the container warmup fails.
    ptyManager.create(
      data.terminalId,
      containerId,
      cols,
      rows,
      workspaceId,
      isBridgeCall(ctx) ? agentId(ctx) : ctx.userId,
      space,
    )
    if (isBridgeCall(ctx))
      await seatAgent(ctx, data.terminalId, (rawData as { agentId?: unknown }).agentId)
    if (subscribe) await subscribeOutput(ctx, data.terminalId)

    if (data.reveal) ptyManager.reveal?.(data.terminalId)

    console.log(
      `✅ [terminal.create] terminal=${data.terminalId} user=${ctx.userId} container=${containerId}`,
    )
    return { terminalId: data.terminalId, cols, rows }
  }

  /**
   * terminal.input
   * Sends keystrokes to the PTY. Does NOT move the waitFor search cursor —
   * user keystrokes are raw input (arrows, ctrl-c, partial lines), not
   * command boundaries, and moving the cursor on each keystroke would make
   * an agent's waitFor skip output while the user types.
   */
  router.register("terminal.input", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; data: string; agentId?: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    await assertTerminalAccess(ctx, data.terminalId, "use")
    let woke: WakeResult | null = null
    if (ptyManager.has(data.terminalId)) {
      woke = await wake(ctx, data.terminalId)
      await beforeInput(ctx, data.terminalId, data.agentId)
    }
    // An agent's keys (answering a menu) start its next terminal.wait window.
    ptyManager.write(data.terminalId, data.data, { moveCursor: false, mark: isBridgeCall(ctx) })
    return { ok: true, ...(woke ? { woke: woke.from } : {}) }
  })

  /**
   * terminal.write
   * Programmatic counterpart of terminal.input for agent/MCA consumers: sends
   * `data` and, when `sendEnter` is true, appends \r so a command line is
   * executed without the caller embedding control characters. Requires a live
   * PTY (TERMINAL_NOT_FOUND otherwise) — a silent no-op here would make an
   * agent believe a command ran when nothing reached a shell.
   *
   * Returns `cursor`: the absolute line index just past the buffer's end at
   * write time. Output produced in reaction to this write (its TTY echo
   * included) lands at/after it — pass it as `since`/`fromLine` to read or
   * waitFor to chain on this command's output only.
   */
  router.register("terminal.write", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as {
      terminalId: string
      data: string
      sendEnter?: boolean
      paste?: boolean | "auto"
      agentId?: string
    }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (typeof data.data !== "string") throw new HandlerError("MISSING_DATA", "data is required")
    if (data.paste !== undefined && typeof data.paste !== "boolean" && data.paste !== "auto") {
      throw new HandlerError("INVALID_PASTE", 'paste must be true, false or "auto"')
    }
    const { woke } = await requireAwake(ctx, data.terminalId, "use")
    await beforeInput(ctx, data.terminalId, data.agentId)
    const pasted = shouldPaste(data.paste ?? false, data.data, data.terminalId)
    const text = pasted ? `\x1b[200~${stripPasteMarkers(data.data)}\x1b[201~` : data.data
    const cursor = ptyManager.write(data.terminalId, data.sendEnter ? `${text}\r` : text)
    return {
      ok: true,
      cursor,
      pasted,
      ...(woke ? { woke } : {}),
      ...(await crewNews(ctx, data.terminalId, data.agentId)),
    }
  })

  /**
   * Multi-line text into an app that takes bracketed paste (Claude Code, vim,
   * bash 5.1+) goes in as one paste: its newlines become part of the text
   * instead of each one pressing Enter (a TUI would submit the first line).
   * `auto`: only when the text has a line break and the app asked for it.
   */
  function shouldPaste(paste: boolean | "auto", text: string, terminalId: string): boolean {
    if (paste === true) return true
    if (paste === false) return false
    return /[\r\n]/.test(text) && (ptyManager.bracketedPaste?.(terminalId) ?? false)
  }

  /**
   * terminal.read
   * Returns buffered PTY output (ANSI-stripped) for programmatic consumers.
   * Either tail mode (`lines`, default 1000) or cursor mode (`since` = the
   * `cursor` of a previous read, returns only newer lines). The response keeps
   * the task's promised `{ output, cursor }` shape and adds `truncated` (older
   * lines were evicted from the circular buffer) plus `notFound` for parity
   * with the manager result.
   */
  router.register("terminal.read", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; lines?: number; since?: number; agentId?: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (data.lines !== undefined && (!Number.isInteger(data.lines) || data.lines < 0)) {
      throw new HandlerError("INVALID_LINES", "lines must be a non-negative integer")
    }
    if (data.since !== undefined && (!Number.isInteger(data.since) || data.since < 0)) {
      throw new HandlerError("INVALID_SINCE", "since must be a non-negative integer")
    }
    const { woke } = await requireAwake(ctx, data.terminalId, "see")

    const result: ReadResult = ptyManager.read(data.terminalId, {
      lines: data.lines,
      fromLine: data.since,
    })
    return {
      output: result.lines.join("\n"),
      cursor: result.nextLine,
      truncated: result.truncated,
      notFound: result.notFound,
      ...(await crewNews(ctx, data.terminalId, data.agentId)),
      ...(woke ? { woke } : {}),
    }
  })

  /**
   * terminal.screen
   * The rendered screen, as a person looking at the terminal sees it: one
   * string per row (trailing spaces trimmed), cursor position and visibility,
   * window title, foreground command and whether a full-screen app (alternate
   * screen) is up. This is what makes TUIs (Claude Code, vim, htop) drivable by
   * an agent — the ANSI-stripped stream of terminal.read is redraw fragments.
   */
  router.register("terminal.screen", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; agentId?: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    const { woke } = await requireAwake(ctx, data.terminalId, "see")
    const screen = await ptyManager.screen(data.terminalId)
    if (!screen)
      throw new HandlerError("TERMINAL_NOT_FOUND", `Terminal ${data.terminalId} not found`)
    return {
      screen,
      question: screenQuestion(screen.lines),
      ...(await crewNews(ctx, data.terminalId, data.agentId)),
      ...(woke ? { woke } : {}),
    }
  })

  /**
   * terminal.waitFor
   * Resolves when the PTY output matches `pattern` (JS regex), checking the
   * buffer first and then every new output line. On timeout the promise
   * rejection is mapped to WAIT_TIMEOUT so clients can distinguish "no match
   * (yet)" from transport errors; `matched: false` is returned instead of an
   * error when the caller opted into soft timeouts via `softTimeout`.
   */
  router.register("terminal.waitFor", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as {
      terminalId: string
      pattern: string
      timeoutMs?: number
      fromLine?: number
      softTimeout?: boolean
    }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (typeof data.pattern !== "string" || data.pattern.length === 0) {
      throw new HandlerError("INVALID_PATTERN", "pattern is required")
    }
    if (data.timeoutMs !== undefined && (!Number.isFinite(data.timeoutMs) || data.timeoutMs <= 0)) {
      throw new HandlerError("INVALID_TIMEOUT", "timeoutMs must be a positive number")
    }
    await requireAwake(ctx, data.terminalId, "see")

    let regex: RegExp
    try {
      regex = new RegExp(data.pattern)
    } catch (err) {
      throw new HandlerError(
        "INVALID_PATTERN",
        `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    try {
      const result: WaitForResult = await ptyManager.waitFor(data.terminalId, regex, {
        timeoutMs: data.timeoutMs,
        fromLine: data.fromLine,
      })
      await assertTerminalAccess(ctx, data.terminalId, "see")
      return {
        matched: result.matched,
        line: result.line,
        lineIndex: result.lineIndex,
        cursor: result.nextLine,
      }
    } catch (err) {
      await assertTerminalAccess(ctx, data.terminalId, "see")
      // Only map the manager's timeout rejection — session death and other
      // failures keep their original message (and INTERNAL_ERROR code).
      if (err instanceof Error && err.message.startsWith("waitFor: timeout")) {
        if (data.softTimeout) {
          return { matched: false, line: null, lineIndex: null, cursor: null }
        }
        throw new HandlerError("WAIT_TIMEOUT", err.message)
      }
      throw err
    }
  })

  /**
   * terminal.wait
   * Await a state instead of a pattern (services/terminal/agent-wait.ts):
   * `until` turn (a coding agent finished its turn, asks something, needs a
   * login or left), ready (a coding agent is up, waiting for input), quiet
   * (no output for quietMs), text (screen contains `text` / matches
   * `pattern`), exit (back at the shell). Only what happens after the last
   * terminal.write counts (`sinceNow: true`: after this call). Never throws on
   * timeout: `met: false` with the current state. Always returns the
   * rendered screen, so the caller needs no extra call to see where things are.
   */
  router.register("terminal.wait", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as {
      terminalId?: string
      until?: unknown
      timeoutMs?: unknown
      quietMs?: unknown
      text?: unknown
      pattern?: unknown
      sinceNow?: unknown
      agentId?: unknown
    }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (!isWaitUntil(data.until)) {
      throw new HandlerError("INVALID_UNTIL", "until must be turn, ready, quiet, text or exit")
    }
    const timeoutMs = data.timeoutMs === undefined ? 30_000 : Number(data.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_STATE_WAIT_MS) {
      throw new HandlerError(
        "INVALID_TIMEOUT",
        `timeoutMs must be between 1 and ${MAX_STATE_WAIT_MS}`,
      )
    }
    const quietMs = data.quietMs === undefined ? undefined : Number(data.quietMs)
    if (quietMs !== undefined && (!Number.isFinite(quietMs) || quietMs < 100 || quietMs > 60_000)) {
      throw new HandlerError("INVALID_QUIET", "quietMs must be between 100 and 60000")
    }
    let pattern: RegExp | undefined
    const text = typeof data.text === "string" && data.text ? data.text : undefined
    if (typeof data.pattern === "string" && data.pattern) {
      try {
        pattern = new RegExp(data.pattern, "m")
      } catch (err) {
        throw new HandlerError(
          "INVALID_PATTERN",
          `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (data.until === "text" && !text && !pattern) {
      throw new HandlerError("INVALID_PATTERN", 'until "text" needs text or pattern')
    }
    const { woke } = await requireAwake(ctx, data.terminalId, "see")
    const terminalId = data.terminalId
    const mark = (data.sinceNow === true
      ? ptyManager.mark(terminalId)
      : ptyManager.lastWriteMark(terminalId)) ?? { at: Date.now(), stateSeq: 0 }
    const started = Date.now()
    const inner = makeWaitCheck({ until: data.until, mark, quietMs, text, pattern })
    // An agent's wait: it shows among the watchers, and it ends early when the
    // wheel changes hands (a person took it, or gave it back). "ready" is the
    // exception: it is a property of the pane (agent running, settled), not of
    // who holds the wheel — a person clicking into a booting session must not
    // abort it (the runner treats "driver" as a fatal ready failure).
    const me =
      isBridgeCall(ctx) && data.until !== "ready" ? await identities.agent(ctx, data.agentId) : null
    const startDriver = driverKey(ptyManager.driver?.(terminalId))
    const check = me
      ? (view: Parameters<typeof inner>[0]): WaitOutcome | null | Promise<WaitOutcome | null> =>
          driverKey(ptyManager.driver?.(terminalId)) !== startDriver
            ? { reason: "driver" }
            : inner(view)
      : inner
    if (me) ptyManager.agentWatching?.(terminalId, me, true)
    let outcome: WaitOutcome | null
    try {
      outcome = await ptyManager.waitUntil(terminalId, check, { timeoutMs })
    } finally {
      if (me) ptyManager.agentWatching?.(terminalId, me, false)
    }
    await assertTerminalAccess(ctx, terminalId, "see")
    const session = ptyManager.describe(terminalId)
    const screen = session ? await ptyManager.screen(terminalId).catch(() => null) : null
    const news = await crewNews(ctx, terminalId, data.agentId)
    return {
      question: screen ? screenQuestion(screen.lines) : null,
      met: outcome !== null && outcome.reason !== "ended" && outcome.reason !== "driver",
      reason: outcome?.reason ?? "timeout",
      ...news,
      ...(outcome?.reason === "driver" ? { driverChanged: news.driver ?? null } : {}),
      ...(outcome?.message ? { message: outcome.message } : {}),
      waitedMs: Date.now() - started,
      alive: session !== null,
      command: session?.command ?? null,
      agentState: session?.agentState ?? null,
      needsAuth: session?.needsAuth ?? null,
      screen,
      ...(woke ? { woke } : {}),
    }
  })

  /**
   * terminal.reveal
   * Ask the person's Terminal window to show a session: a `terminal_sessions`
   * event with reason "reveal" on the workspace's topic (the window opens or
   * focuses that session's tab).
   */
  router.register("terminal.reveal", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    await requireSession(ctx, data.terminalId, "see")
    ptyManager.reveal(data.terminalId)
    return { ok: true, watchers: stream?.watchers(data.terminalId) ?? [] }
  })

  /**
   * terminal.resize
   * Resizes the PTY. A write: the pane has one size, shared by everyone
   * watching it.
   */
  router.register("terminal.resize", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; cols: number; rows: number }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    await assertTerminalAccess(ctx, data.terminalId, "use")
    ptyManager.resize(data.terminalId, data.cols, data.rows)
    return { ok: true }
  })

  /**
   * terminal.destroy
   * Kills the PTY session.
   */
  const pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()

  router.register("terminal.destroy", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; undoMs?: unknown }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")

    await ptyManager.whenAdopted?.()
    await assertTerminalAccess(ctx, data.terminalId, "manage")
    if (isBridgeCall(ctx) && !ptyManager.has(data.terminalId))
      throw new HandlerError(
        "TERMINAL_NOT_FOUND",
        `No session ${data.terminalId} here: terminal-list shows the open ones`,
      )
    const undoMs = Number(data.undoMs)
    const terminalId = data.terminalId
    const delayed =
      data.undoMs !== undefined && Number.isFinite(undoMs) && undoMs > 0 && undoMs <= 30_000
    if (delayed && !ptyManager.has(terminalId)) return { ok: true }
    clearTimeout(pendingCloses.get(terminalId))
    pendingCloses.delete(terminalId)
    if (delayed) {
      const timer = setTimeout(() => {
        pendingCloses.delete(terminalId)
        void assertTerminalAccess(ctx, terminalId, "manage").then(
          () => destroyNow(ctx.sessionId, terminalId),
          () => undefined,
        )
      }, undoMs)
      timer.unref?.()
      pendingCloses.set(terminalId, timer)
      return { ok: true, closingInMs: undoMs }
    }
    destroyNow(ctx.sessionId, terminalId)
    return { ok: true }
  })

  function destroyNow(sessionId: string, terminalId: string): void {
    ptyManager.destroy(terminalId)
    pubSubService.unsubscribeSession(sessionId, `terminal:${terminalId}`)
    console.log(`✅ [terminal.destroy] terminal=${terminalId}`)
  }

  router.register("terminal.cancelClose", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    await assertTerminalAccess(ctx, data.terminalId, "manage")
    const timer = pendingCloses.get(data.terminalId)
    clearTimeout(timer)
    pendingCloses.delete(data.terminalId)
    return { ok: true, cancelled: timer !== undefined }
  })

  /**
   * terminal.update
   * Label: `title`. `pinned` (the old lifetime policy) is still accepted and
   * ignored: every session is kept until it is closed, and sleeps when idle.
   */
  router.register("terminal.update", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; pinned?: boolean; title?: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (data.pinned !== undefined && typeof data.pinned !== "boolean") {
      throw new HandlerError("INVALID_PINNED", "pinned must be a boolean")
    }
    if (data.title !== undefined && typeof data.title !== "string") {
      throw new HandlerError("INVALID_TITLE", "title must be a string")
    }
    await requireSession(ctx, data.terminalId, "manage")
    if (data.title !== undefined) await ptyManager.rename(data.terminalId, data.title)
    const session = ptyManager.describe(data.terminalId)
    return { session: session ? describe(session) : null }
  })

  /**
   * terminal.subscribe
   * Subscribes the current session to streaming output for a terminal window.
   * Requires a live PTY: terminal output is shell I/O, so blind subscriptions
   * to arbitrary future terminalIds are not allowed.
   */
  router.register("terminal.subscribe", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")

    if (!ptyManager.has(data.terminalId)) {
      throw new HandlerError("TERMINAL_NOT_FOUND", `Terminal ${data.terminalId} not found`)
    }
    await assertTerminalAccess(ctx, data.terminalId, "see")

    const topic = `terminal:${data.terminalId}`
    await subscribeOutput(ctx, data.terminalId)

    console.log(`✅ [terminal.subscribe] session=${ctx.sessionId} subscribed to ${topic}`)
    return { terminalId: data.terminalId, topic }
  })

  /**
   * terminal.unsubscribe
   * Unsubscribes the current session from a terminal's streaming output.
   * Always allowed — it only removes the caller's own subscription.
   */
  router.register("terminal.unsubscribe", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")

    const topic = `terminal:${data.terminalId}`
    pubSubService.unsubscribeSession(ctx.sessionId, topic)

    console.log(`✅ [terminal.unsubscribe] session=${ctx.sessionId} unsubscribed from ${topic}`)
    return { terminalId: data.terminalId }
  })

  /** Sessions the caller may see: workspace write access; host shells only for system admins. */
  async function visibleSessions(
    ctx: WsHandlerContext,
    workspaceId?: string,
  ): Promise<SessionInfo[]> {
    await ptyManager.whenAdopted?.()
    if (isBridgeCall(ctx)) {
      const own = await bridgeWorkspace(ctx)
      if (!own || (workspaceId && workspaceId !== own)) return []
      workspaceId = own
    }
    const sessions: SessionInfo[] = ptyManager.list()
    const visible: SessionInfo[] = []
    let hostAllowed: boolean | undefined
    const principals = new Map<string, Principal>()
    for (const session of sessions) {
      const owner = session.ownerWorkspaceId
      if (!owner) continue
      if (workspaceId && owner !== workspaceId) continue
      if (ptyManager.isHost(session.terminalId)) {
        hostAllowed ??= await mayUseHostPty(ctx)
        if (!hostAllowed) continue
      }
      const principal = principals.get(owner) ?? (await callerPrincipal(ctx, owner))
      principals.set(owner, principal)
      if (!mayReachSession(session, owner, principal)) continue
      visible.push(describe(session))
    }
    return visible
  }

  /**
   * terminal.watch
   * Live session list of a workspace: subscribes the caller to
   * `terminals:{workspaceId}` (terminal_sessions events: created, exit,
   * agent_state, title, command, frozen, awake, sleep, wake, input, driver,
   * watchers, conflict…; every event carries the session with its
   * `lifecycle`, `driver`, `watchers` and `conflict`) and returns the current list.
   */
  router.register("terminal.watch", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { workspaceId: string }
    if (!data.workspaceId) throw new HandlerError("MISSING_WORKSPACE_ID", "workspaceId is required")
    if (isBridgeCall(ctx) && (await bridgeWorkspace(ctx)) !== data.workspaceId) {
      throw new HandlerError("FORBIDDEN_WORKSPACE", `No access to workspace ${data.workspaceId}`)
    }
    if (!(await canWriteWorkspace(db, ctx.userId, data.workspaceId))) {
      throw new HandlerError(
        "FORBIDDEN_WORKSPACE_ROLE",
        "Write access to the workspace is required",
      )
    }
    if (!isBridgeCall(ctx)) {
      pubSubService.subscribeSession(ctx.sessionId, sessionsTopic(data.workspaceId))
      pubSubService.subscribeSession(ctx.sessionId, sessionsTopic(data.workspaceId, ctx.userId))
    }
    return { workspaceId: data.workspaceId, sessions: await visibleSessions(ctx, data.workspaceId) }
  })

  router.register("terminal.unwatch", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { workspaceId: string }
    if (!data.workspaceId) throw new HandlerError("MISSING_WORKSPACE_ID", "workspaceId is required")
    pubSubService.unsubscribeSession(ctx.sessionId, sessionsTopic(data.workspaceId))
    pubSubService.unsubscribeSession(ctx.sessionId, sessionsTopic(data.workspaceId, ctx.userId))
    return { workspaceId: data.workspaceId }
  })

  /**
   * terminal.ticket
   * Single-use, 60 s ticket for the /ws/terminal data plane (each attach on it
   * re-checks access). Refused through the MCA bridge: agents use read/screen.
   */
  router.register("terminal.ticket", async (ctx: WsHandlerContext) => {
    if (!stream)
      throw new HandlerError(
        "TERMINAL_STREAM_UNAVAILABLE",
        "The terminal stream is not available on this server",
      )
    if (isBridgeCall(ctx))
      throw new HandlerError(
        "FORBIDDEN",
        "Agents read terminals with terminal.read / terminal.screen",
      )
    const user = await collection(db, COLLECTIONS.users).findOne({ userId: ctx.userId })
    const name = String(
      user?.profile?.displayName ?? user?.displayName ?? user?.name ?? user?.email ?? ctx.userId,
    )
    const avatarUrl = (user?.profile?.avatarUrl as string | undefined) ?? null
    return { ticket: stream.issueTicket(ctx.userId, name, avatarUrl), path: "/ws/terminal" }
  })

  /**
   * terminal.list
   * Lists live PTY sessions. Workspace-sovereign: only sessions of workspaces
   * the caller can write to are returned (read-role members see none —
   * terminalIds are capability-ish and session titles/commands leak work).
   * Unowned (legacy) sessions are hidden, and so are host sessions unless the
   * caller may use a host shell. Optional `workspaceId` filter.
   * Deliberately does NOT touch the manager's activity clock nor wake anything
   * (passive polling must not keep a machine running).
   */
  router.register("terminal.list", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { workspaceId?: string }
    return { sessions: await visibleSessions(ctx, data.workspaceId) }
  })

  /**
   * terminal.status
   * Detailed status of one PTY session (buffer cursors, lifecycle, foreground
   * process). Same authz + existence contract as read/write: workspace access
   * first, then TERMINAL_NOT_FOUND when there is no session. Passive — unless
   * `wake: true`: then it wakes the session first (an agent about to use it)
   * and says what it woke from (`woke`).
   */
  router.register("terminal.status", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; wake?: boolean }
    if (!data.terminalId) throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    await requireSession(ctx, data.terminalId, "see")
    const woke = data.wake === true ? ((await wake(ctx, data.terminalId))?.from ?? null) : null

    const status: SessionStatus | null = ptyManager.getStatus(data.terminalId)
    if (!status) {
      // Raced with the TTL sweep / PTY exit between the gate and the read.
      throw new HandlerError("TERMINAL_NOT_FOUND", `Terminal ${data.terminalId} not found`)
    }
    return { status, ...(woke ? { woke } : {}) }
  })

  // ── The wheel (terminal crew) ─────────────────────────────────────────────

  /** The wheel is a person's: an agent never takes or gives it on their behalf. */
  async function wheelCaller(ctx: WsHandlerContext, terminalId: unknown, action: AccessAction) {
    if (typeof terminalId !== "string" || !terminalId)
      throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    if (isBridgeCall(ctx))
      throw new HandlerError(
        "FORBIDDEN",
        "Agent control is switched by people in the Terminal window",
      )
    await requireSession(ctx, terminalId, action)
    return identities.human(ctx.userId)
  }

  async function openerWhoAnswers(terminalId: string): Promise<string | null> {
    const opener = personalOwnerOf(ptyManager.describe(terminalId))
    if (!opener) return null
    const workspaceId = ptyManager.ownerOf(terminalId)
    return workspaceId && (await canWriteWorkspace(db, opener, workspaceId)) ? opener : null
  }

  async function wheelAnswerer(
    terminalId: string,
    userId: string,
  ): Promise<{ id: string; typing: boolean } | null> {
    const busy = ptyManager.busyPerson?.(terminalId, userId) ?? null
    if (busy) return { id: busy.id, typing: true }
    const opener = await openerWhoAnswers(terminalId)
    return opener ? { id: opener, typing: false } : null
  }

  async function assertMayAnswerWheel(userId: string, terminalId: string): Promise<void> {
    const answerer = await wheelAnswerer(terminalId, userId)
    if (!answerer || answerer.id === userId) return
    const { name } = await identities.human(answerer.id)
    const role = answerer.typing ? "is typing in this session" : "opened this session"
    throw new HandlerError(
      "NOT_YOUR_WHEEL",
      `${name || "Someone else"} ${role}: only they can switch Agent on or answer this request.`,
    )
  }

  function leaseCall<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof LeaseError) throw new HandlerError(err.code, err.message)
      throw err
    }
  }

  /**
   * terminal.takeWheel
   * The caller drives: their face on the seat, the agent that drove becomes
   * the copilot (its writes are refused while they are active, its
   * terminal.wait returns early). Works on a sleeping session too.
   */
  router.register("terminal.takeWheel", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown }
    const who = await wheelCaller(ctx, data.terminalId, "use")
    const terminalId = data.terminalId as string
    ptyManager.takeWheel?.(terminalId, who)
    return { ok: true, driver: ptyManager.driver?.(terminalId) ?? null }
  })

  /**
   * terminal.giveBack
   * The person at the wheel gives it back: to the agent that drove before
   * (or to nobody). `note` (optional) reaches that agent once, as `handedBack`
   * on its next terminal.wait / read / screen.
   */
  router.register("terminal.giveBack", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; note?: unknown }
    if (data.note !== undefined && data.note !== null && typeof data.note !== "string")
      throw new HandlerError("INVALID_NOTE", "note must be a string")
    const who = await wheelCaller(ctx, data.terminalId, "control")
    const terminalId = data.terminalId as string
    await assertMayAnswerWheel(ctx.userId, terminalId)
    leaseCall(() => ptyManager.giveBack?.(terminalId, who, (data.note as string | null) ?? null))
    const driver = ptyManager.driver?.(terminalId) ?? null
    if (driver?.kind === "agent" && driver.id)
      for (const answer of wheelWaiters.get(wheelKey(terminalId, driver.id)) ?? [])
        answer("approved", { id: who.id, name: who.name || who.id })
    return { ok: true, driver }
  })

  /**
   * terminal.yield
   * Two people typing at once (conflict): the caller cedes the wheel `to` the
   * other one (a userId of the conflict).
   */
  router.register("terminal.yield", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; to?: unknown }
    if (typeof data.to !== "string" || !data.to)
      throw new HandlerError("INVALID_TARGET", "to (the other person's userId) is required")
    const who = await wheelCaller(ctx, data.terminalId, "use")
    const terminalId = data.terminalId as string
    const to = await identities.human(data.to)
    leaseCall(() => ptyManager.yieldWheel?.(terminalId, who, to))
    return { ok: true, driver: ptyManager.driver?.(terminalId) ?? null }
  })

  router.register("terminal.releaseWheel", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; agentId?: unknown }
    if (!isBridgeCall(ctx))
      throw new HandlerError("FORBIDDEN", "People switch Agent on in the Terminal window")
    if (typeof data.terminalId !== "string" || !data.terminalId)
      throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    const terminalId = data.terminalId
    await requireSession(ctx, terminalId, "use")
    const who = await identities.agent(ctx, data.agentId)
    const released = ptyManager.releaseWheel?.(terminalId, who) ?? false
    return { released, driver: ptyManager.driver?.(terminalId) ?? null }
  })

  router.register("terminal.agentControl", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; enabled?: unknown }
    const who = await wheelCaller(ctx, data.terminalId, "control")
    if (typeof data.enabled !== "boolean")
      throw new HandlerError("INVALID_ENABLED", "enabled must be a boolean")
    const terminalId = data.terminalId as string
    await assertMayAnswerWheel(ctx.userId, terminalId)
    const pending = ptyManager.describe(terminalId)?.wheelRequest?.agent ?? null
    leaseCall(() => ptyManager.setAgentControl(terminalId, who, data.enabled as boolean))
    const by = { id: who.id, name: who.name || who.id }
    if (pending)
      for (const answer of wheelWaiters.get(wheelKey(terminalId, pending.id)) ?? [])
        answer(data.enabled ? "approved" : "denied", by)
    const session = ptyManager.describe(terminalId)
    return { ok: true, agentControl: session?.agentControl ?? false, driver: session?.driver ?? null }
  })

  router.register("terminal.watchable", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; enabled?: unknown }
    await wheelCaller(ctx, data.terminalId, "manage")
    if (typeof data.enabled !== "boolean")
      throw new HandlerError("INVALID_ENABLED", "enabled must be a boolean")
    const terminalId = data.terminalId as string
    if (!personalOwnerOf(ptyManager.describe(terminalId)))
      throw new HandlerError(
        "NOT_WATCHABLE",
        "A shared terminal is already the workspace's: every member with write access sees it",
      )
    ptyManager.setWatchable(terminalId, data.enabled)
    return { ok: true, watchable: ptyManager.describe(terminalId)?.watchable ?? false }
  })

  type AnsweredBy = { id: string; name: string }
  type WheelAnswer = (outcome: "approved" | "denied", by: AnsweredBy) => void
  const wheelWaiters = new Map<string, Set<WheelAnswer>>()
  const wheelKey = (terminalId: string, agentId: string) => `${terminalId}\u0000${agentId}`

  router.register("terminal.requestWheel", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as {
      terminalId?: unknown
      reason?: unknown
      timeoutMs?: unknown
      agentId?: unknown
    }
    if (!isBridgeCall(ctx))
      throw new HandlerError("FORBIDDEN", "People switch Agent off in the Terminal window")
    if (typeof data.terminalId !== "string" || !data.terminalId)
      throw new HandlerError("MISSING_TERMINAL_ID", "terminalId is required")
    const timeoutMs = data.timeoutMs === undefined ? 90_000 : Number(data.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_STATE_WAIT_MS)
      throw new HandlerError(
        "INVALID_TIMEOUT",
        `timeoutMs must be between 1 and ${MAX_STATE_WAIT_MS}`,
      )
    const terminalId = data.terminalId
    await requireSession(ctx, terminalId, "use")
    const who = await identities.agent(ctx, data.agentId)
    const held = ptyManager.agentMayWrite?.(terminalId, who) ?? null
    if (!held) {
      ptyManager.noteInput?.(terminalId, { kind: "agent", id: agentId(ctx), name: who.name }, who)
      return {
        outcome: "granted",
        driver: ptyManager.driver?.(terminalId) ?? null,
        ...(await crewNews(ctx, terminalId, data.agentId)),
      }
    }
    const openerAnswers = (await openerWhoAnswers(terminalId)) !== null
    const pending = ptyManager.describe(terminalId)?.wheelRequest
    if (pending && pending.agent.id !== who.id)
      return {
        outcome: "busy",
        askedBy: { id: pending.agent.id, name: pending.agent.name || pending.agent.id },
        driver: ptyManager.driver?.(terminalId) ?? null,
      }
    if (!pending)
      ptyManager.requestWheel?.(
        terminalId,
        who,
        typeof data.reason === "string" ? data.reason : null,
        openerAnswers,
      )
    const key = wheelKey(terminalId, who.id)
    const waiters = wheelWaiters.get(key) ?? new Set<WheelAnswer>()
    wheelWaiters.set(key, waiters)
    let answeredBy: AnsweredBy | null = null
    const outcome = await new Promise<"approved" | "denied" | "pending" | "ended">((resolve) => {
      const done = (o: "approved" | "denied" | "pending" | "ended") => {
        clearTimeout(timer)
        clearInterval(alive)
        waiters.delete(answer)
        if (waiters.size === 0) wheelWaiters.delete(key)
        resolve(o)
      }
      const answer: WheelAnswer = (o, by) => {
        answeredBy = by
        done(o)
      }
      const timer = setTimeout(() => done("pending"), timeoutMs)
      const alive = setInterval(() => {
        if (!ptyManager.has(terminalId)) done("ended")
      }, 1000)
      waiters.add(answer)
    })
    return {
      outcome,
      driver: ptyManager.driver?.(terminalId) ?? null,
      ...(answeredBy ? { answeredBy } : {}),
      ...(await crewNews(ctx, terminalId, data.agentId)),
    }
  })

  router.register("terminal.answerWheel", async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as { terminalId?: unknown; approve?: unknown; agentId?: unknown }
    const who = await wheelCaller(ctx, data.terminalId, "control")
    if (typeof data.approve !== "boolean")
      throw new HandlerError("INVALID_APPROVE", "approve must be a boolean")
    const terminalId = data.terminalId as string
    const approve = data.approve
    const answers = typeof data.agentId === "string" && data.agentId ? data.agentId : undefined
    if (ptyManager.describe(terminalId)?.wheelRequest) await assertMayAnswerWheel(ctx.userId, terminalId)
    const asked = leaseCall(() => ptyManager.answerWheel?.(terminalId, approve, answers))
    const by = { id: who.id, name: who.name || who.id }
    if (asked)
      for (const answer of wheelWaiters.get(wheelKey(terminalId, asked.id)) ?? [])
        answer(approve ? "approved" : "denied", by)
    return { ok: true, driver: ptyManager.driver?.(terminalId) ?? null }
  })

}
