/**
 * Claude Code runner — a To Do task worked by a Claude Code session in the
 * workspace's terminal host (docs/specs/tasks/20261031_claude-code-runner.md).
 *
 * A runner agent (`agents.runner === 'claude-code'`, CCR-REQ-1) has no LLM
 * core: when one of its tasks starts, this service opens a Claude Code
 * session for it (CCR-REQ-2) with a scoped API token (CCR-REQ-3) and the
 * tasks MCP endpoint configured (routes/mcp-tasks-routes.ts), sends the
 * task's kick-off message, and watches the session's turns to keep the task
 * in step (CCR-REQ-6). A runner also reviews (CCR-REQ-7).
 *
 * @spec CCR-REQ-2
 * @spec CCR-REQ-3
 * @spec CCR-REQ-6
 * @spec CCR-REQ-7
 */
import { randomBytes } from "node:crypto"
import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { WebSocket } from "ws"
import { createApiToken } from "../../auth/api-tokens"
import {
  type NodeIO,
  type NodeState,
  TODO_NODES_COLLECTION,
  type TodoNode,
  writeNode,
  writeStateTransition,
} from "../../mca-actions/todo"
import type { LogActor, LogEntry } from "../../mca-actions/todo-log"
import type { WsRouter } from "../../ws-framework/WsRouter"
import { buildTodoInitialMessage } from "../todo-autoplay-service"
import type { LaunchOptions } from "./launch-options"
import { isAgentCommand } from "./agent-wait"

// ── Constants ────────────────────────────────────────────────────────────────

/** A task token lives a week: long enough for any session, short enough to forget (CCR-REQ-3). */
/** A pane this young is still booting (claude not yet foreground): reuse it -
 * concurrent scheduler passes must not spawn a herd of terminals. */
const TERMINAL_BOOT_GRACE_MS = 3 * 60_000

export const TASK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The single boot cwd of every runner session (Pablo, 2-nov): all Claude
 * Code sessions the runner opens — fresh or `--resume` — start in
 * /workspace, the one directory the term-host's trust map already accepts.
 * The task's brief tells Claude which repo to work in; Claude `cd`s from
 * there. One cwd, one casuistry: no session can ever boot in an untrusted
 * directory and hang on the trust dialog (fb_53dc509e82f7b0c0).
 */
export const RUNNER_CWD = "/workspace"
/** The MCP server name Claude Code sees; its tools are `mcp__<name>__<tool>`. */
export const MCP_SERVER_NAME = "teros-tasks"
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
/** Session environment (CCR-REQ-3): the MCP config (with the token) and the contract. */
export const ENV_MCP_CONFIG = "TEROS_TASKS_MCP_CONFIG"
export const ENV_SYSTEM_PROMPT = "TEROS_TASKS_SYSTEM_PROMPT"
export const ENV_TASK_ID = "TEROS_TASK_ID"
/** One `terminal.wait` at a time (the handler's cap is 100 s). */
const WAIT_MS = 90_000
const READY_WAIT_MS = 100_000
/** Wheel changes during the boot wait are retried this many times before failing the open. */
const READY_DRIVER_RETRIES = 3
/** A watch gives up after this long (a session asleep all weekend is not a task in progress). */
export const WATCH_MAX_MS = 8 * 60 * 60 * 1000
/** How long to poll for the Claude Code session id after ready (CCR-REQ-8). */
/**
 * The Claude Code session id out of a `terminal.status` response. The handler
 * answers `{ status: { agentSession, … }, woke? }` (tmux `@agent_session`; for
 * a sleeping session the id saved at sleep); a flat `{ agentSession }` is
 * tolerated too. Null while the pane has none yet, or when it is malformed.
 */
export function agentSessionFromStatus(res: unknown): string | null {
  const r = res as { status?: { agentSession?: unknown }; agentSession?: unknown } | null | undefined
  const raw = r?.status?.agentSession ?? r?.agentSession
  const id = typeof raw === "string" ? raw.trim() : ""
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null
}

const SESSION_ID_WAIT_MS = 30_000
/** Consecutive transient wait failures the watch rides out before giving up. */
export const WATCH_MAX_TRANSIENT_ERRORS = 5
export const WATCH_RETRY_MS = 5_000

/** The terminal host no longer knows the terminal: the watch has nothing left to watch. */
export function isTerminalGone(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /TERMINAL_NOT_FOUND/.test(m)
}

/**
 * Should a failed `--resume` boot be retried as a fresh session? Yes for any
 * failure except a missing sign-in (a fresh session would need it too). A
 * session id whose conversation never reached disk dies instantly with "No
 * conversation found" and used to block the task (31-oct incident).
 */
export function shouldFallbackToFresh(resuming: boolean, err: unknown): boolean {
  if (!resuming) return false
  const m = err instanceof Error ? err.message : String(err)
  return !/needs a sign-in/i.test(m)
}

/** Kickoff line for a reopened session — Claude Code already carries the
 * task context; the note just tells it to pick up where it left off. */
const RESUME_NOTE =
  "This is your previous session, reopened. Pick up exactly where you left off on this task; re-check its state with the todo tools only if you need a refresher."
const SESSION_ID_POLL_MS = 2_000

export type Kickoff = "brief" | "resume-note" | "none"

/**
 * The kick-off an open actually sends (CCR-REQ-2, CCR-REQ-8). The full brief
 * belongs to a NEW conversation only: a live terminal being reused already
 * carries it, and the scheduler re-opens live sessions every tick — re-pasting
 * the brief burned tokens and made Claude answer "same assignment, continuing".
 * Not even the resume note: its text ("previous session, reopened") is false
 * for a live terminal and would be one more message per tick.
 * @spec CCR-REQ-2
 */
export function effectiveKickoff(kickoff: Kickoff, reuse: boolean): Kickoff {
  return reuse && kickoff === "brief" ? "none" : kickoff
}
const BASH_MCA_ID = "mca.teros.bash"

export type RunnerKind = "task" | "review"

/** Where the session is in its life (CCR-REQ-8): the bubble reflects it. */
export type RunnerSessionStatus = "live" | "sleeping" | "gone"

/**
 * What the task records about its session (CCR-REQ-2 d, CCR-REQ-8): the
 * terminal, the Claude Code conversation (for `--resume`), and where the
 * session is in its life. `sessionId` is what Claude Code's own hooks report
 * (the tmux pane's `@agent_session`); it is what lets a destroyed terminal be
 * recreated with the full conversation intact.
 */
export interface TaskRunnerRecord {
  kind: "claude-code"
  terminalId: string
  /** Claude Code's session id (its hooks report it) — the `--resume` key. */
  sessionId?: string
  startedAt: number
  /** Last time the watch saw the session alive (epoch ms). */
  lastAliveAt?: number
  /** live | sleeping | gone — kept current by the watch (CCR-REQ-8). */
  status?: RunnerSessionStatus
  /**
   * The terminal question this session's watch blocked the task on — the
   * watch's own block, and the only blockedReason it ever lifts back to
   * `working` when a turn ends (the person answered in the terminal,
   * CCR-REQ-6). Spent (null) once lifted, and null whenever the current
   * block is not the watch's: a task the agent blocked through its tools to
   * wait for the operator, or the operator blocked by hand, waits for its
   * owner — no automatic mechanism unblocks it (reminder-loop fix, 1-nov).
   */
  sessionQuestion?: string | null
  reviewTerminalId?: string
  /** The review session's Claude Code id, for `--resume` (CCR-REQ-8). */
  reviewSessionId?: string
  reviewStartedAt?: number
  /** Last time the watch saw the review session alive (epoch ms). */
  reviewLastAliveAt?: number
  /** live | sleeping | gone — the review session's life (CCR-REQ-8). */
  reviewStatus?: RunnerSessionStatus
}

/**
 * Derive a session's status from what is known without touching the terminal
 * host: a record that never heard from the watch is `live` (just opened), one
 * the watch refreshed recently is `live` or `sleeping` as last seen, and one
 * whose watch ended (or that was never refreshed) is `gone` once its terminal
 * is no longer around. Pure — the watch and the readers share it.
 * @spec CCR-REQ-8
 */
export function runnerStatusOf(
  rec: Pick<TaskRunnerRecord, "status" | "lastAliveAt" | "startedAt"> | undefined,
  now = Date.now(),
): RunnerSessionStatus {
  if (!rec) return "gone"
  if (rec.status === "live" || rec.status === "sleeping") {
    // A live/sleeping mark older than the watch's horizon is stale: the watch
    // ended (session destroyed, backend restarted) — treat it as gone.
    const last = rec.lastAliveAt ?? rec.startedAt
    return now - last <= WATCH_MAX_MS ? rec.status : "gone"
  }
  return rec.status ?? "live"
}

// ── Pure builders (unit-tested) ──────────────────────────────────────────────

export interface RunnerLaunchInput {
  mcpUrl: string
  token: string
  nodeId: string
  systemPrompt: string
}

/**
 * The session's launch options (CCR-REQ-3): the MCP config and the contract
 * travel in the environment; the typed line references them by name.
 */
export function runnerLaunch(input: RunnerLaunchInput): LaunchOptions {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: input.mcpUrl,
        headers: { Authorization: `Bearer ${input.token}` },
      },
    },
  }
  return {
    env: {
      [ENV_MCP_CONFIG]: JSON.stringify(config),
      [ENV_SYSTEM_PROMPT]: input.systemPrompt,
      [ENV_TASK_ID]: input.nodeId,
    },
    args: [
      "--mcp-config",
      `"$${ENV_MCP_CONFIG}"`,
      "--strict-mcp-config",
      "--append-system-prompt",
      `"$${ENV_SYSTEM_PROMPT}"`,
      "--permission-mode",
      "auto",
    ],
  }
}

/**
 * The launch options of a session recreated on its previous conversation
 * (CCR-REQ-8): same MCP config and contract as a fresh one, plus
 * `--resume <sessionId>` so Claude Code comes back with everything it knew.
 * The id rides as a literal argument (it is not a secret: a random uuid) and
 * is validated the same way `claudeResumeLine` does.
 * @spec CCR-REQ-8
 */
export function resumeLaunch(input: RunnerLaunchInput & { sessionId: string }): LaunchOptions {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.sessionId)) {
    throw new RangeError(`sessionId "${input.sessionId}" is not a Claude Code session id`)
  }
  return {
    env: runnerLaunch(input).env,
    args: [...runnerLaunch(input).args, "--resume", input.sessionId],
  }
}

/** The contract appended to Claude Code's system prompt for the session. */
export function runnerSystemPrompt(kind: RunnerKind, nodeId: string): string {
  const common = [
    `You are a Claude Code runner of Teros, working inside the workspace's terminal. ${
      kind === "review" ? "You are REVIEWING" : "You are WORKING ON"
    } the Teros task ${nodeId}.`,
    `The task's tools are the MCP server "${MCP_SERVER_NAME}" (tools named ${TOOL_PREFIX}<tool>). They are the only way to report; nothing you print in this terminal reaches the task.`,
    "Keep the task updated as you go: progress with set-progress, notes with add-log-entry. Every write is attributed to you in the task log.",
    "Never end a turn without reporting on the task first.",
    "A person may type in this terminal at any time; treat what they write as instructions from the task's operator.",
    "Never delegate: do all the work in this session.",
  ]
  const specific =
    kind === "review"
      ? [
          'To finish the review, do exactly one of: accept it (set-state with state "done"); send it back (set-state with state "working" and a "reply" that says precisely what is missing); or, if you cannot decide without the operator, add-log-entry with your question and end your turn.',
        ]
      : [
          'To finish, deliver the output with set-output, then set-state with state "review". Never send to review what you could not finish.',
          'If you need something from the operator (a decision, a credential, access), set-state with state "blocked" and your question as the reason, then end your turn; you will be resumed when they answer.',
        ]
  return [...common, ...specific].join(" ")
}

/** Nudge sent once when a turn ends without a delivery (CCR-REQ-6). */
export const REMINDER_MESSAGE = `Your turn ended but the task is still in progress. If the work is done, deliver the output with ${TOOL_PREFIX}set-output and set the state to "review" with ${TOOL_PREFIX}set-state; if you are stuck, set it to "blocked" with your question as the reason; otherwise add a progress note with ${TOOL_PREFIX}add-log-entry and continue.`

/** The delivered output as text for a review kick-off. */
export function describeOutput(output: NodeIO | null | undefined): string {
  if (!output) return "No output was delivered."
  if (output.format === "markdown") return output.markdown
  if (output.format === "form") return JSON.stringify(output.values, null, 2)
  return `File: ${output.name} (${output.mime}, ${output.size} bytes) — ${output.url}`
}

export interface ReviewKickoffContext {
  path: string[]
  toolPrefix: string
  /** Last log entries, newest last. */
  notes: LogEntry[]
}

/**
 * The review kick-off (CCR-REQ-7): what was asked, what was delivered, how
 * it went, and the three outcomes.
 */
export function buildReviewKickoff(node: TodoNode, ctx: ReviewKickoffContext): string {
  const T = ctx.toolPrefix
  const notes = ctx.notes.length
    ? ctx.notes.map(
        (e) =>
          `- ${new Date(e.timestamp).toISOString()} · ${e.actor?.kind ?? "system"}${e.actor?.id ? ` ${e.actor.id}` : ""}: ${e.text}`,
      )
    : ["(no notes)"]
  return [
    "You are the reviewer of a task that just entered review. Evaluate it against its instructions and definition of done, then decide.",
    "",
    `## Task: ${node.text}`,
    `**Id:** \`${node.nodeId}\``,
    `**Path:** ${ctx.path.length > 0 ? ctx.path.join(" › ") : "(root)"}`,
    "",
    "## Description",
    node.description?.trim() || "No description provided.",
    "",
    "## Instructions (the checklist is the definition of done)",
    node.instructions?.trim() || "No instructions provided.",
    "",
    "## Delivered output",
    describeOutput(node.output),
    "",
    "## How it went (task log, latest entries)",
    ...notes,
    "",
    "## Your decision",
    `- Read the task at any time with \`${T}get-node\` (nodeId \`${node.nodeId}\`); the output and the full log are there.`,
    `- **Accept:** \`${T}set-state\` with state \`done\`.`,
    `- **Send back:** \`${T}set-state\` with state \`working\` and a \`reply\` saying precisely what is missing; the executor resumes with your note.`,
    `- **Cannot decide:** \`${T}add-log-entry\` with your question for the operator, then end your turn.`,
    "- Review both the process (the log) and the output (against the instructions). Do not redo the work yourself.",
  ].join("\n")
}

// ── The service ──────────────────────────────────────────────────────────────

export interface ClaudeCodeRunnerDeps {
  db: Db
  wsRouter: Pick<WsRouter, "dispatch">
  /** `POST /mcp/tasks` as the terminal host's containers reach it. */
  mcpUrl: string
  /** Broadcast a node write to the workspace (`todo_node_changed`). */
  broadcast: (workspaceId: string, node: TodoNode, action: string) => Promise<void>
}

interface WaitResult {
  met: boolean
  reason: string
  message?: string
  question?: { question: string | null; detail: string | null } | null
  alive: boolean
  command: string | null
  agentState: { state: string; message?: string } | null
  needsAuth: string | null
}

/**
 * The verdict on a session's ready-wait (CCR-REQ-8): ready is ready — and so
 * is a wheel change to a person: the click-opened terminal is live, revealed
 * and now driven by the person who clicked, which is the point of the click.
 * Anything else (needsAuth, ended, timeout) fails the open.
 */
export function readyVerdict(ready: WaitResult): {
  ok: boolean
  personDrove: boolean
  error: string | null
} {
  if (ready.met) return { ok: true, personDrove: false, error: null }
  if (ready.reason === "driver")
    return { ok: true, personDrove: true, error: null }
  const error = ready.needsAuth
    ? `Claude Code needs a sign-in in the terminal (${ready.needsAuth}) — the workspace owner needs an Anthropic API-key provider in Teros`
    : `Claude Code did not become ready (${ready.reason}${ready.message ? `: ${ready.message}` : ""})`
  return { ok: false, personDrove: false, error }
}

interface Watch {
  kind: RunnerKind
  workspaceId: string
  nodeId: string
  terminalId: string
  agentId: string
  ctx: WsHandlerContext
}

export class ClaudeCodeRunner {
  constructor(private readonly deps: ClaudeCodeRunnerDeps) {}

  /**
   * Opens in progress, keyed by `workspaceId:nodeId:kind`. `runner.terminalId`
   * is only written once the session is ready (up to READY_WAIT_MS later), so
   * during that window a second open (an autoplay retry, a manual start-node
   * after a client timeout) cannot see the first one's terminal and used to
   * create another. A concurrent open for the same session joins the one in
   * flight instead (CCR-REQ-2).
   */
  private readonly inflight = new Map<string, Promise<TodoNode>>()

  /**
   * Open the session for a task that just moved to `working` (CCR-REQ-2
   * b–d). Throws when the session cannot be opened or Claude Code does not
   * become ready — the caller rolls the start back. Returns the task with
   * its `runner` record.
   *
   * CCR-REQ-8: when the task already has a session (a blocked→working resume,
   * an orphaned working task, a backend restart), the SAME session comes back
   * instead of a fresh one — `claude --resume <sessionId>` on a new terminal,
   * or the existing terminal when it is still alive. The runner continues
   * where it was instead of re-reading the task cold.
   * @spec CCR-REQ-2
   * @spec CCR-REQ-8
   */
  // @todo alice - 2026.11.01 : open() has no per-task start mutex - concurrent
  // scheduler passes during a boot can both proceed (one reusing, one creating),
  // and a reused open can double the kick-off. The boot-grace in terminalAlive
  // stops the terminal herd; an in-flight guard here would stop the rest.
  async startTask(
    workspaceId: string,
    node: TodoNode,
    agentId: string,
    billingUserId: string,
  ): Promise<TodoNode> {
    return this.open("task", workspaceId, node, agentId, billingUserId)
  }

  /**
   * Open a review session for a task that entered `review` with this runner
   * as reviewer (CCR-REQ-7). A review session whose terminal is gone is
   * recreated on its conversation, exactly like a task session (CCR-REQ-8).
   * @spec CCR-REQ-7
   * @spec CCR-REQ-8
   */
  async startReview(
    workspaceId: string,
    node: TodoNode,
    agentId: string,
    billingUserId: string,
  ): Promise<TodoNode> {
    return this.open("review", workspaceId, node, agentId, billingUserId)
  }

  /**
   * Bring a task's session back for a person looking at it (CCR-REQ-8 piece
   * 2): the terminal alive → reveal it in their Terminal window; gone →
   * recreate it with `claude --resume <sessionId>` (full context intact) and
   * reveal that. A task with no session record (or no sessionId to resume)
   * opens a fresh one. Returns the terminal that is now on screen.
   * @spec CCR-REQ-8
   */
  async reopenTerminal(
    workspaceId: string,
    node: TodoNode,
    agentId: string,
    billingUserId: string,
  ): Promise<{ terminalId: string; resumed: boolean }> {
    const rec = (node as TodoNode & { runner?: TaskRunnerRecord }).runner
    const kind: RunnerKind = "task"
    const terminalId = rec?.terminalId
    const sessionId = rec?.sessionId
    const ctx = bridgeContext(await this.bashAppOf(workspaceId), workspaceId, agentId, billingUserId)
    if (terminalId && (await this.terminalAlive(ctx, terminalId))) {
      await this.call(ctx, "terminal.reveal", { terminalId })
      return { terminalId, resumed: false }
    }
    // Gone (or never had one): reopen on the previous conversation when there
    // is one, fresh otherwise — the same path the runner itself resumes by.
    const updated = await this.open(
      kind,
      workspaceId,
      node,
      agentId,
      billingUserId,
      // A person clicked: the session is for watching, not for a new kick-off.
      { kickoff: sessionId ? "resume-note" : "none", reveal: true },
    )
    const fresh = (updated as TodoNode & { runner?: TaskRunnerRecord }).runner
    return { terminalId: fresh?.terminalId ?? terminalId ?? "", resumed: Boolean(sessionId) }
  }

  /**
   * Single-flight over `openOnce`: one open per task session at a time.
   * @spec CCR-REQ-2
   */
  private open(
    kind: RunnerKind,
    workspaceId: string,
    node: TodoNode,
    agentId: string,
    billingUserId: string,
    opts: { kickoff?: "brief" | "resume-note" | "none"; reveal?: boolean } = {},
  ): Promise<TodoNode> {
    const key = `${workspaceId}:${node.nodeId}:${kind}`
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.openOnce(kind, workspaceId, node, agentId, billingUserId, opts).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }

  private async openOnce(
    kind: RunnerKind,
    workspaceId: string,
    node: TodoNode,
    agentId: string,
    billingUserId: string,
    opts: { kickoff?: "brief" | "resume-note" | "none"; reveal?: boolean; fresh?: boolean } = {},
  ): Promise<TodoNode> {
    // Autoplay sessions boot hidden: revealing them lets the person's Terminal
    // window attach and steal the wheel mid-boot, which used to abort the
    // ready wait (reason "driver") and kill the session at startup. A person
    // opening the task later reveals it via reopenTerminal.
    const reveal = opts.reveal ?? false
    const { db } = this.deps
    const bashAppId = await this.bashAppOf(workspaceId)
    const ctx = bridgeContext(bashAppId, workspaceId, agentId, billingUserId)
    const actor: LogActor = { kind: "agent", id: agentId }

    // (CCR-REQ-8) resume-on-restart: a task that already has a session gets
    // the SAME conversation back. The existing terminal still alive → reuse
    // it (wake + reveal); gone but a sessionId → a new terminal launched with
    // `--resume`; no sessionId → a fresh session, as before.
    const prev = (node as TodoNode & { runner?: TaskRunnerRecord }).runner
    const prevTerminalId = kind === "review" ? prev?.reviewTerminalId : prev?.terminalId
    const prevSessionId = opts.fresh
      ? undefined
      : kind === "review"
        ? prev?.reviewSessionId
        : prev?.sessionId
    const reuse = prevTerminalId
      ? await this.terminalAlive(ctx, prevTerminalId).catch(() => false)
      : false
    const kickoff = effectiveKickoff(opts.kickoff ?? "brief", reuse)

    // (CCR-REQ-3) the scoped token, minted for this session only.
    const { token } = await createApiToken(db, {
      userId: billingUserId,
      agentId,
      label: `Claude Code runner · ${kind} · ${node.nodeId}`,
      workspaceId,
      scope: "tasks:run",
      nodeId: node.nodeId,
      ttlMs: TASK_TOKEN_TTL_MS,
    })
    const base = {
      mcpUrl: this.deps.mcpUrl,
      token,
      nodeId: node.nodeId,
      systemPrompt: runnerSystemPrompt(kind, node.nodeId),
    }
    const resuming = !reuse && Boolean(prevSessionId)
    const launch = resuming ? resumeLaunch({ ...base, sessionId: prevSessionId! }) : runnerLaunch(base)

    // (CCR-REQ-2 b) the session: a Claude Code terminal seated by the agent.
    // A resumed session keeps its terminalId — the record (and anything that
    // references it, like the day-view bubble) stays valid.
    // Every session boots in the single RUNNER_CWD — fresh or resumed (the
    // cwd of a terminal.create is the pane's start dir, and --resume finds
    // its transcript because runner transcripts live under -workspace).
    const terminalId = reuse ? prevTerminalId! : `term_ccr_${randomBytes(6).toString("hex")}`
    const title = (kind === "review" ? `Review: ${node.text}` : node.text).slice(0, 120)
    if (!reuse) {
      await this.call(ctx, "terminal.create", {
        terminalId,
        appId: bashAppId,
        preset: "claude",
        title,
        cwd: RUNNER_CWD,
        agentId,
        launch,
        subscribe: false,
        reveal,
      })
    }

    try {
      // (CCR-REQ-2 c) ready, then the kick-off. A wheel change mid-boot is not
      // fatal: re-seat and wait again (up to READY_DRIVER_RETRIES times) — only
      // timeout/ended/needs-login fail the open.
      let verdict: ReturnType<typeof readyVerdict> | null = null
      for (let attempt = 0; attempt <= READY_DRIVER_RETRIES; attempt++) {
        const ready = await this.call<WaitResult>(ctx, "terminal.wait", {
          terminalId,
          until: "ready",
          timeoutMs: READY_WAIT_MS,
          agentId,
        })
        verdict = readyVerdict(ready)
        if (verdict.ok || ready.reason !== "driver") break
        // Re-seat: any agent write goes through beforeInput -> noteInput, which
        // puts this agent back at the wheel (an empty write seats without typing).
        await this.call(ctx, "terminal.write", { terminalId, data: "", agentId }).catch(() => {})
      }
      const finalVerdict = verdict!
      if (!finalVerdict.ok) throw new Error(finalVerdict.error!)
      const path = await this.pathOf(workspaceId, node)
      if (kickoff !== "none" && !finalVerdict.personDrove) {
        const message =
          kickoff === "resume-note"
            ? RESUME_NOTE
            : kind === "review"
              ? buildReviewKickoff(node, {
                  path,
                  toolPrefix: TOOL_PREFIX,
                  notes: (node.log ?? []).slice(-15),
                })
              : buildTodoInitialMessage(node, { path, toolPrefix: TOOL_PREFIX })
        await this.call(ctx, "terminal.write", {
          terminalId,
          data: message,
          sendEnter: true,
          paste: true,
          agentId,
        })
      }
    } catch (err) {
      if (!reuse) await this.call(ctx, "terminal.destroy", { terminalId }).catch(() => undefined)
      // A dead conversation must not block the task: its brief carries the
      // context, so boot a fresh session once before failing the open.
      if (shouldFallbackToFresh(resuming, err)) {
        console.warn(
          `[ClaudeCodeRunner] --resume ${prevSessionId} failed for ${node.nodeId} (${err instanceof Error ? err.message : err}); retrying fresh`,
        )
        return this.openOnce(kind, workspaceId, node, agentId, billingUserId, {
          ...opts,
          kickoff: "brief",
          fresh: true,
        })
      }
      throw err
    }

    // (CCR-REQ-8) the session id Claude Code itself reports (its hooks write
    // it to the pane; terminal.status surfaces it). Polled briefly: the id
    // arrives with the first hook event, usually before the kick-off answer.
    const sessionId = await this.captureSessionId(ctx, terminalId)

    // (CCR-REQ-2 d, CCR-REQ-8) the record on the task.
    const now = Date.now()
    // (reminder-loop fix, 1-nov) a fresh session's watch has blocked nothing
    // yet — but a block a previous watch left may still be waiting for the
    // person: keep the marker while it still matches the current block, so a
    // recreated session (CCR-REQ-8 piece 2) lifts it when they answer. Every
    // other marker is stale (its block was lifted by the operator's reply,
    // not by a watch) and must go, or it could match — and lift — a future
    // block that just happens to reuse the same words.
    const sessionQuestion =
      node.state === "blocked" &&
      typeof node.blockedReason === "string" &&
      prev?.sessionQuestion === node.blockedReason
        ? node.blockedReason
        : null
    const record: Partial<TaskRunnerRecord> =
      kind === "review"
        ? {
            kind: "claude-code",
            reviewTerminalId: terminalId,
            ...(sessionId ? { reviewSessionId: sessionId } : {}),
            reviewStartedAt: reuse ? (prev?.reviewStartedAt ?? now) : now,
            reviewLastAliveAt: now,
            reviewStatus: "live",
          }
        : {
            kind: "claude-code",
            terminalId,
            ...(sessionId ? { sessionId } : {}),
            startedAt: reuse ? (prev?.startedAt ?? now) : now,
            lastAliveAt: now,
            status: "live",
            sessionQuestion,
          }
    const $set = Object.fromEntries(Object.entries(record).map(([k, v]) => [`runner.${k}`, v]))
    // A brand-new session that reported no id must not keep the previous
    // (dead) one: the next reopen would `--resume` it and fail instantly.
    const $unset =
      !reuse && !resuming && !sessionId
        ? [kind === "review" ? "runner.reviewSessionId" : "runner.sessionId"]
        : undefined
    const updated = await writeNode(db, workspaceId, node.nodeId, {
      // The session opened — the start succeeded: reset the failure counter (TODOAP-REQ-32).
      $set: { ...$set, startFailCount: 0 },
      ...($unset ? { $unset } : {}),
      log: {
        text: reuse
          ? `Claude Code ${kind === "review" ? "review " : ""}session still alive in terminal "${title}" (${terminalId})`
          : opts.fresh
            ? `Claude Code ${kind === "review" ? "review " : ""}started FRESH (previous conversation could not be resumed) in terminal "${title}" (${terminalId})`
            : resuming
            ? `Claude Code ${kind === "review" ? "review " : ""}resumed (--resume ${prevSessionId}) in terminal "${title}" (${terminalId})`
            : `Claude Code ${kind === "review" ? "review " : ""}started in terminal "${title}" (${terminalId})`,
        actor,
      },
    })
    if (!updated) throw new Error(`task ${node.nodeId} disappeared while recording its session`)

    // (TODOAP-REQ-20 parity) the kick-off starts a turn: light the row's working
    // dot exactly like an agent turn does for a conversation task.
    const turnStarted = kind === "task" && kickoff !== "none"
    if (turnStarted) {
      await this.setRunning(workspaceId, node.nodeId, true).catch(() => undefined)
    }

    // (CCR-REQ-6) the watch — in the background, never awaited by the caller.
    void this.watch({ kind, workspaceId, nodeId: node.nodeId, terminalId, agentId, ctx }).catch(
      (err) => {
        console.error(`[ClaudeCodeRunner] watch of ${terminalId} failed:`, err)
      },
    )
    return updated
  }

  /**
   * Read the Claude Code session id off the terminal (CCR-REQ-8): its hooks
   * report it (tmux `@agent_session` → `terminal.status` → `agentSession`).
   * Best-effort with a short poll — the id usually arrives with the first
   * hook event, seconds after ready; when it never does (older hook script,
   * a session that never fired a hook) the record simply carries none and
   * recreation falls back to a fresh session.
   */
  private async captureSessionId(ctx: WsHandlerContext, terminalId: string): Promise<string | undefined> {
    const deadline = Date.now() + SESSION_ID_WAIT_MS
    while (Date.now() < deadline) {
      try {
        const res = await this.call<unknown>(ctx, "terminal.status", { terminalId })
        const id = agentSessionFromStatus(res)
        if (id) return id
      } catch {
        return undefined // status refused (gone already) — nothing to read
      }
      await new Promise((r) => setTimeout(r, SESSION_ID_POLL_MS))
    }
    return undefined
  }

  /** Is the session still around AND its agent still usable? A pane that
   * survived an agent crash (OOM kill, /exit…) is alive but useless: reusing
   * it waits for a ready that will never come and the open times out.
   * Reusable: the agent is the foreground command (awake or frozen — both
   * wake on use), or the session is sleeping (it wakes with the agent session
   * restored). Anything else — a shell in the foreground, a stale agentState
   * left by a dead agent — is a dead pane: open a fresh session instead. */
  private async terminalAlive(ctx: WsHandlerContext, terminalId: string): Promise<boolean> {
    try {
      const { status } = await this.call<{
        status: { lifecycle: string; command: string | null; createdAt: number | Date }
      }>(ctx, "terminal.status", { terminalId })
      if (!status) return false
      if (isAgentCommand(status.command)) return true
      if (status.lifecycle === "sleeping") return true
      // Young pane still on bash = boot in progress, not a dead pane: reuse.
      // Without this, every scheduler pass during the ~30s boot spawned a new
      // terminal (the 1-nov herd: five same-titled terminals in one minute).
      const created = new Date(status.createdAt).getTime()
      return Date.now() - created < TERMINAL_BOOT_GRACE_MS
    } catch {
      return false
    }
  }

  /**
   * Keep the task in step with the session (CCR-REQ-6): blocked when Claude
   * Code asks, back to working when it resumes, one reminder when a turn ends
   * without a delivery, and a closing log entry in every case.
   * @spec CCR-REQ-6
   */
  private async watch(w: Watch): Promise<void> {
    if (w.kind === "task") this.watching.add(w.nodeId)
    try {
      await this.watchLoop(w)
    } finally {
      if (w.kind === "task") {
        this.watching.delete(w.nodeId)
        // The watch is over (finished, superseded, session gone): no live turn.
        await this.setRunning(w.workspaceId, w.nodeId, false, w.terminalId).catch(() => undefined)
      }
    }
  }

  /** Task ids with a live watch in this process (a `running` flag without one is a zombie). */
  private readonly watching = new Set<string>()
  hasWatch(nodeId: string): boolean {
    return this.watching.has(nodeId)
  }

  /**
   * The `running` flag of a Claude Code task — true while its terminal turn is
   * in flight, so the Todo row shows the same working dot as a conversation
   * task (TODOAP-REQ-8/20). `mine` guards a stale watch from clearing a newer
   * session's flag. Broadcasts only on an actual change.
   */
  async setRunning(workspaceId: string, nodeId: string, running: boolean, mine?: string): Promise<void> {
    const guard: Record<string, unknown> = { running: running ? { $ne: true } : true }
    if (running) guard.state = "working"
    if (mine) guard["runner.terminalId"] = mine
    const updated = await writeNode(this.deps.db, workspaceId, nodeId, { $set: { running }, guard })
    if (updated) await this.deps.broadcast(workspaceId, updated, "claude-code-runner").catch(() => undefined)
  }

  private async watchLoop(w: Watch): Promise<void> {
    const { db } = this.deps
    const deadline = Date.now() + WATCH_MAX_MS
    let reminders = 0
    const actor: LogActor = { kind: "agent", id: w.agentId }
    const nodes = db.collection<TodoNode>(TODO_NODES_COLLECTION)

    let transientErrors = 0
    while (Date.now() < deadline) {
      let r: WaitResult
      try {
        r = await this.call<WaitResult>(w.ctx, "terminal.wait", {
          terminalId: w.terminalId,
          until: "turn",
          timeoutMs: WAIT_MS,
          agentId: w.agentId,
        })
        transientErrors = 0
      } catch (err) {
        // A host hiccup (INTERNAL_ERROR, a dropped control client) is not the
        // end of the session: ride it out; only a vanished terminal or a
        // persistent failure stops the watch (2-nov incident).
        if (!isTerminalGone(err) && ++transientErrors <= WATCH_MAX_TRANSIENT_ERRORS) {
          await new Promise((res) => setTimeout(res, WATCH_RETRY_MS))
          continue
        }
        await this.note(
          w,
          `Claude Code session watch stopped: ${err instanceof Error ? err.message : String(err)}`,
          actor,
        )
        return
      }
      const node = await nodes.findOne({ workspaceId: w.workspaceId, nodeId: w.nodeId })
      if (!node) return
      const current = (node as TodoNode & { runner?: TaskRunnerRecord }).runner
      const mine = w.kind === "review" ? current?.reviewTerminalId : current?.terminalId
      if (mine !== w.terminalId) return // superseded by a newer session
      const state = (node.state ?? "pending") as NodeState

      // Marker hygiene (reminder-loop fix, 1-nov): the watch's block marker
      // is only meaningful while the block it recorded stands. The task back
      // on an open state (the operator unblocked by hand or replied) spends
      // it — otherwise a later block that just happens to reuse the same
      // words could be mistaken for ours and lifted.
      if (state !== "blocked" && current?.sessionQuestion != null) {
        await writeNode(db, w.workspaceId, w.nodeId, {
          $set: { "runner.sessionQuestion": null },
        }).catch((err) =>
          console.warn(`[ClaudeCodeRunner] marker clear on ${w.nodeId} failed:`, err),
        )
      }

      if (
        !r.alive ||
        r.reason === "exit" ||
        r.reason === "ended" ||
        (r.command !== null && r.command !== "claude")
      ) {
        await this.note(w, "Claude Code session ended", actor)
        return
      }
      if (r.reason === "timeout" || r.reason === "driver") continue
      // The turn ended (done / blocked): the working dot stops.
      if (w.kind === "task") await this.setRunning(w.workspaceId, w.nodeId, false, w.terminalId).catch(() => undefined)

      if (w.kind === "review") {
        if (state !== "review") {
          await this.note(
            w,
            state === "done" ? "Claude Code accepted the task" : "Claude Code sent the task back",
            actor,
          )
          return
        }
        if (r.reason === "blocked") {
          await this.note(w, `Claude Code (reviewer) is waiting: ${questionOf(r)}`, actor)
          continue
        }
        if (reminders === 0) {
          reminders++
          await this.remind(w)
          await this.note(w, "Reminder sent: the review turn ended without a decision", actor)
          continue
        }
        await this.note(
          w,
          "Claude Code ended its review turn without a decision; the task stays in review",
          actor,
        )
        return
      }

      // kind === "task"
      if (state === "review" || state === "done" || state === "cancelled") {
        await this.note(w, "Claude Code finished", actor)
        return
      }
      if (r.reason === "blocked") {
        if (state === "working") {
          const question = questionOf(r)
          const blocked = await writeStateTransition(db, w.workspaceId, node, "blocked", {
            reason: question,
            log: `Claude Code is waiting: ${question}`,
            actor,
          })
          if (blocked) {
            // The watch's own block: remember the question so a later turn end
            // lifts exactly this block (and only it) back to working — the
            // person answered in the terminal. Any other blockedReason (the
            // agent's own set-state blocked waiting for the operator, the
            // operator's manual block) is not ours to lift.
            const marked = await writeNode(db, w.workspaceId, node.nodeId, {
              $set: { "runner.sessionQuestion": question },
              guard: { state: "blocked", blockedReason: question },
            })
            if (marked) await this.deps.broadcast(w.workspaceId, marked, "claude-code-runner")
            await this.deps.broadcast(w.workspaceId, blocked, "claude-code-runner")
          }
        }
        continue
      }
      if (r.reason === "done") {
        // A turn ended with the task blocked. The watch lifts exactly one
        // block: its own (the terminal question it recorded when it blocked
        // — the person answered in the terminal, CCR-REQ-6). Any other
        // blockedReason is somebody else's wait: the agent blocked through
        // its own tools to wait for the operator (the two-phase validation
        // rule), or the operator blocked by hand. Those are not ours — no
        // unblock, no reminder, no new turn. The watch steps aside so the
        // owner's block stands until they answer; the session stays for them
        // to drive it (reopenTerminal / typing in the terminal).
        const sessionQuestion = current?.sessionQuestion ?? null
        const mine = state === "blocked" && sessionQuestion !== null && node.blockedReason === sessionQuestion
        if (state === "blocked" && !mine) {
          await this.note(
            w,
            `Claude Code ended its turn; the task stays blocked (${node.blockedReason ?? "waiting for the operator"})`,
            actor,
          )
          return
        }
        let node2: TodoNode = node
        if (mine) {
          const working = await writeStateTransition(db, w.workspaceId, node, "working", {
            log: "Unblocked: Claude Code resumed",
            actor,
          })
          if (working) {
            node2 = working
            // The marker is spent atomically with the unblock
            // (writeStateTransition unsets runner.sessionQuestion on every
            // blocked → open transition) — nothing else to clear here.
            await this.deps.broadcast(w.workspaceId, working, "claude-code-runner")
          }
        }
        if (node2.state === "working") {
          if (reminders === 0) {
            reminders++
            await this.remind(w)
            await this.setRunning(w.workspaceId, w.nodeId, true).catch(() => undefined)
            await this.note(
              w,
              "Reminder sent: Claude Code ended its turn without delivering",
              actor,
            )
            continue
          }
          await this.note(
            w,
            "Claude Code ended its turn without delivering; the task stays in progress",
            actor,
          )
          return
        }
        // mine but the unblock raced (the task changed under us): re-read and
        // re-evaluate on the next turn — never remind into someone else's change.
      }
    }
    await this.note(w, "Claude Code session watch ended (time limit)", actor)
  }

  private async remind(w: Watch): Promise<void> {
    await this.call(w.ctx, "terminal.write", {
      terminalId: w.terminalId,
      data: REMINDER_MESSAGE,
      sendEnter: true,
      paste: true,
      agentId: w.agentId,
    }).catch((err) => console.warn(`[ClaudeCodeRunner] reminder to ${w.terminalId} failed:`, err))
  }

  private async note(w: Watch, text: string, actor: LogActor): Promise<void> {
    const updated = await writeNode(this.deps.db, w.workspaceId, w.nodeId, {
      log: { text, actor },
    }).catch((err) => {
      console.warn(`[ClaudeCodeRunner] log on ${w.nodeId} failed:`, err)
      return null
    })
    if (updated)
      await this.deps.broadcast(w.workspaceId, updated, "claude-code-runner").catch(() => undefined)
  }

  /** The workspace's bash app — the container the terminal host is cloned from. */
  private async bashAppOf(workspaceId: string): Promise<string> {
    const apps = this.deps.db.collection<{ appId: string; status?: string }>("apps")
    const app =
      (await apps.findOne(
        { mcaId: BASH_MCA_ID, ownerId: workspaceId, status: { $in: ["active", "standby"] } },
        { projection: { appId: 1 } },
      )) ??
      (await apps.findOne(
        { mcaId: BASH_MCA_ID, ownerId: workspaceId },
        { projection: { appId: 1 } },
      ))
    if (!app)
      throw new Error(`workspace ${workspaceId} has no Bash app: the terminal host needs one`)
    return app.appId
  }

  /** Ancestors' texts, root first (the kick-off's "Path"). */
  private async pathOf(workspaceId: string, node: TodoNode): Promise<string[]> {
    const nodes = this.deps.db.collection<TodoNode>(TODO_NODES_COLLECTION)
    const path: string[] = []
    let parentId = node.parentId
    for (let depth = 0; parentId && depth < 32; depth++) {
      const parent = await nodes.findOne(
        { workspaceId, nodeId: parentId },
        { projection: { text: 1, parentId: 1 } },
      )
      if (!parent) break
      path.unshift(parent.text)
      parentId = parent.parentId
    }
    return path
  }

  /** One WS-router action with the bridge context, answered as a promise. */
  private call<T = unknown>(
    ctx: WsHandlerContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = `ccr_${randomBytes(6).toString("hex")}`
      const fakeWs = {
        readyState: 1,
        send(payload: string) {
          try {
            const msg = JSON.parse(payload) as {
              type: string
              data?: T
              code?: string
              message?: string
            }
            if (msg.type === "response") resolve(msg.data as T)
            else if (msg.type === "error")
              reject(new Error(`${action}: ${msg.code ?? "ERROR"} ${msg.message ?? ""}`.trim()))
          } catch (err) {
            reject(err)
          }
        },
      } as unknown as WebSocket
      this.deps.wsRouter.dispatch(fakeWs, ctx, requestId, action, params).catch(reject)
    })
  }
}

/**
 * The bridge context the runner acts with: the workspace owner (billing) as
 * user, the bash app as the `mca:` session (what isBridgeCall checks), the
 * runner agent as actor (seat, crew identity, log attribution).
 */
export function bridgeContext(
  bashAppId: string,
  workspaceId: string,
  agentId: string,
  billingUserId: string,
): WsHandlerContext {
  return {
    userId: billingUserId,
    sessionId: `mca:${bashAppId}`,
    ip: "claude-code-runner",
    actor: { kind: "agent", agentId, workspaceId, appId: bashAppId },
  }
}

function questionOf(r: WaitResult): string {
  const q = r.question?.question?.trim()
  if (q) return r.question?.detail ? `${q} — ${r.question.detail}` : q
  return (
    r.message?.trim() || r.agentState?.message?.trim() || "waiting for an answer in the terminal"
  )
}
