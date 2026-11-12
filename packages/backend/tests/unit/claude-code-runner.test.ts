/**
 * Unit tests — Claude Code runner, the pure parts
 * (docs/specs/tasks/20261031_claude-code-runner.md).
 *
 * No database: the launch options (CCR-REQ-3), the launch-option validation
 * `terminal.create` applies to bridge calls (CCR-REQ-2), the kick-offs with
 * MCP tool names (CCR-REQ-2, CCR-REQ-7) and the bridge context.
 */
import { describe, expect, it } from "bun:test"
// The capability registry first (todo.ts on its own hits the registry's circular import).
import "../../src/mca-actions"
import type { TodoNode } from "../../src/mca-actions/todo"
import {
  ClaudeCodeRunner,
  agentSessionFromStatus,
  bridgeContext,
  buildReviewKickoff,
  describeOutput,
  effectiveKickoff,
  isTerminalGone,
  shouldFallbackToFresh,
  ENV_MCP_CONFIG,
  ENV_SYSTEM_PROMPT,
  ENV_TASK_ID,
  MCP_SERVER_NAME,
  readyVerdict,
  REMINDER_MESSAGE,
  resumeLaunch,
  RUNNER_CWD,
  runnerLaunch,
  runnerStatusOf,
  runnerSystemPrompt,
  TOOL_PREFIX,
  WATCH_MAX_MS,
} from "../../src/services/terminal/claude-code-runner"
import { appendLaunchArgs, parseLaunchOptions } from "../../src/services/terminal/launch-options"
import { buildTodoInitialMessage } from "../../src/services/todo-autoplay-service"

const TOKEN = "tak_0123456789abcdef0123456789abcdef0123456789abcdef"

function task(overrides: Partial<TodoNode> = {}): TodoNode {
  return {
    nodeId: "tn_task1",
    parentId: null,
    workspaceId: "ws_1",
    text: "Ship the thing",
    description: "Make it ship.",
    instructions: "- [ ] build\n- [ ] test",
    completed: false,
    collapsed: false,
    position: 0,
    log: [],
    createdAt: 1,
    updatedAt: 1,
    kind: "task",
    state: "working",
    ...overrides,
  }
}

describe("runnerLaunch (CCR-REQ-3)", () => {
  const launch = runnerLaunch({
    mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
    token: TOKEN,
    nodeId: "tn_task1",
    systemPrompt: "contract",
  })

  it("[CCR-AC-5] carries the token in the environment, never in the arguments", () => {
    const config = JSON.parse(launch.env[ENV_MCP_CONFIG])
    expect(config.mcpServers[MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: "http://host.docker.internal:3000/mcp/tasks",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(launch.env[ENV_SYSTEM_PROMPT]).toBe("contract")
    expect(launch.env[ENV_TASK_ID]).toBe("tn_task1")
    expect(launch.args.join(" ")).not.toContain(TOKEN)
    expect(launch.args.join(" ")).toContain(`--mcp-config "$${ENV_MCP_CONFIG}"`)
    expect(launch.args.join(" ")).toContain("--strict-mcp-config")
    expect(launch.args.join(" ")).toContain("--permission-mode auto")
  })

  it("[CCR-AC-5] is exactly what terminal.create accepts from a bridge call", () => {
    const parsed = parseLaunchOptions(launch)
    expect(parsed).toEqual(launch)
    expect(appendLaunchArgs("clear; claude", parsed!.args)).toBe(
      `clear; claude --mcp-config "$${ENV_MCP_CONFIG}" --strict-mcp-config --append-system-prompt "$${ENV_SYSTEM_PROMPT}" --permission-mode auto`,
    )
  })
})

describe("parseLaunchOptions (CCR-REQ-2)", () => {
  it("absent → null; empty object → no env, no args", () => {
    expect(parseLaunchOptions(undefined)).toBeNull()
    expect(parseLaunchOptions(null)).toBeNull()
    expect(parseLaunchOptions({})).toEqual({ env: {}, args: [] })
  })

  it("rejects non-TEROS environment, non-string values and shell fragments in args", () => {
    expect(() => parseLaunchOptions({ env: { ANTHROPIC_API_KEY: "x" } })).toThrow(/TEROS_/)
    expect(() => parseLaunchOptions({ env: { HOME: "/tmp" } })).toThrow(/TEROS_/)
    expect(() => parseLaunchOptions({ env: { TEROS_X: 1 } })).toThrow(/string/)
    expect(() => parseLaunchOptions({ args: ["--ok", "; rm -rf /"] })).toThrow(
      /not an allowed argument/,
    )
    expect(() => parseLaunchOptions({ args: ["$(whoami)"] })).toThrow(/not an allowed argument/)
    expect(() => parseLaunchOptions({ args: ['"$HOME"'] })).toThrow(/not an allowed argument/)
    expect(() => parseLaunchOptions({ args: "x" })).toThrow(/array/)
    expect(() => parseLaunchOptions([])).toThrow(/object/)
  })

  it("accepts long flags, bare words and quoted TEROS_* references", () => {
    expect(
      parseLaunchOptions({ args: ["--permission-mode", "acceptEdits", '"$TEROS_A"'] }),
    ).toEqual({
      env: {},
      args: ["--permission-mode", "acceptEdits", '"$TEROS_A"'],
    })
  })
})

describe("kick-offs with MCP tool names (CCR-REQ-2, CCR-REQ-7)", () => {
  it("the task kick-off names the tools with the MCP prefix", () => {
    const msg = buildTodoInitialMessage(task(), { path: ["Product"], toolPrefix: TOOL_PREFIX })
    expect(msg).toContain(`${TOOL_PREFIX}set-output`)
    expect(msg).toContain(`${TOOL_PREFIX}set-state`)
    expect(msg).toContain(`${TOOL_PREFIX}get-node`)
    expect(msg).not.toContain("todo-list_")
    expect(msg).toContain("**Path:** Product")
  })

  it("without a prefix the kick-off keeps the todo-list names (TODOAP unchanged)", () => {
    const msg = buildTodoInitialMessage(task(), { path: [] })
    expect(msg).toContain("todo-list_set-output")
    expect(msg).not.toContain(TOOL_PREFIX)
  })

  it("[CCR-AC-7] the review kick-off carries the delivered output, the log and the three outcomes", () => {
    const node = task({
      state: "review",
      output: { format: "markdown", markdown: "# Report\nAll good." },
      log: [
        {
          timestamp: 1_700_000_000_000,
          text: "Autoplay: started by Claude Code",
          actor: { kind: "system" },
        },
      ],
    })
    const msg = buildReviewKickoff(node, { path: [], toolPrefix: TOOL_PREFIX, notes: node.log })
    expect(msg).toContain("# Report\nAll good.")
    expect(msg).toContain("tn_task1")
    expect(msg).toContain("Autoplay: started by Claude Code")
    expect(msg).toContain(`${TOOL_PREFIX}set-state\` with state \`done\``)
    expect(msg).toContain(`state \`working\` and a \`reply\``)
    expect(msg).toContain(`${TOOL_PREFIX}add-log-entry`)
  })

  it("describeOutput renders every output format", () => {
    expect(describeOutput(null)).toMatch(/No output/)
    expect(describeOutput({ format: "markdown", markdown: "md" })).toBe("md")
    expect(describeOutput({ format: "form", fields: [], values: { a: 1 } })).toContain('"a": 1')
    expect(
      describeOutput({
        format: "file",
        objectId: "o",
        url: "https://x/y.pdf",
        name: "y.pdf",
        mime: "application/pdf",
        size: 12,
      }),
    ).toContain("y.pdf")
  })

  it("the contract names the task and the MCP server for both kinds", () => {
    expect(runnerSystemPrompt("task", "tn_1")).toContain("tn_1")
    expect(runnerSystemPrompt("task", "tn_1")).toContain(TOOL_PREFIX)
    expect(runnerSystemPrompt("task", "tn_1")).toContain('"review"')
    expect(runnerSystemPrompt("review", "tn_1")).toContain('"done"')
    expect(REMINDER_MESSAGE).toContain(`${TOOL_PREFIX}set-output`)
  })
})

describe("bridgeContext", () => {
  it("acts as the billing user through the bash app with the agent as actor", () => {
    expect(bridgeContext("app_bash", "ws_1", "ag_runner", "u_owner")).toEqual({
      userId: "u_owner",
      sessionId: "mca:app_bash",
      ip: "claude-code-runner",
      actor: { kind: "agent", agentId: "ag_runner", workspaceId: "ws_1", appId: "app_bash" },
    })
  })
})

describe("resumeLaunch (CCR-REQ-8)", () => {
  it("[CCR-AC-2] is runnerLaunch plus --resume <sessionId>, same environment", () => {
    const fresh = runnerLaunch({
      mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
      token: TOKEN,
      nodeId: "tn_task1",
      systemPrompt: "contract",
    })
    const resumed = resumeLaunch({
      mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
      token: TOKEN,
      nodeId: "tn_task1",
      systemPrompt: "contract",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    })
    expect(resumed.env).toEqual(fresh.env)
    expect(resumed.cwd).toEqual(fresh.cwd)
    expect(resumed.args.slice(0, fresh.args.length)).toEqual(fresh.args)
    expect(resumed.args.slice(fresh.args.length)).toEqual([
      "--resume",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ])
    // still a valid terminal.create payload
    expect(parseLaunchOptions(resumed)).toEqual(resumed)
  })

  it("[CCR-AC-2] rejects a malformed session id — never interpolates it into a command line", () => {
    expect(() =>
      resumeLaunch({
        mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
        token: TOKEN,
        nodeId: "tn_task1",
        systemPrompt: "contract",
        sessionId: "rm -rf /; echo",
      }),
    ).toThrow()
    expect(() =>
      resumeLaunch({
        mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
        token: TOKEN,
        nodeId: "tn_task1",
        systemPrompt: "contract",
        sessionId: "",
      }),
    ).toThrow()
  })
})

describe("runnerStatusOf (CCR-REQ-8)", () => {
  it("reads the stored status, absent reads as live, no record as gone (nothing to resume)", () => {
    const now = Date.now()
    expect(runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: now, status: "sleeping" })).toBe("sleeping")
    expect(runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: now, status: "gone" })).toBe("gone")
    expect(runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: now })).toBe("live")
    expect(runnerStatusOf(null)).toBe("gone")
  })

  it("a live/sleeping record older than WATCH_MAX_MS reads as gone (the watch is dead)", () => {
    const stale = Date.now() - (WATCH_MAX_MS + 60_000)
    expect(
      runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: stale, status: "live" }),
    ).toBe("gone")
    expect(
      runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: stale, status: "sleeping" }),
    ).toBe("gone")
    // a fresh pulse still reads as itself
    expect(
      runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: Date.now(), status: "live" }),
    ).toBe("live")
    // gone stays gone regardless of age
    expect(
      runnerStatusOf({ kind: "claude-code", terminalId: "t1", startedAt: 1, lastAliveAt: stale, status: "gone" }),
    ).toBe("gone")
  })
})

describe("readyVerdict (CCR-REQ-8)", () => {
  const base = {
    question: null,
    alive: true,
    command: "claude",
    agentState: null,
    needsAuth: null,
  }

  it("ready is ready, no kick-off skip", () => {
    expect(readyVerdict({ ...base, met: true, reason: "ready" })).toEqual({
      ok: true,
      personDrove: false,
      error: null,
    })
  })

  it("a person taking the wheel mid-open is success, not a failure", () => {
    expect(readyVerdict({ ...base, met: false, reason: "driver" })).toEqual({
      ok: true,
      personDrove: true,
      error: null,
    })
  })


  it("needsAuth, ended and timeout still fail the open", () => {
    const auth = readyVerdict({ ...base, met: false, reason: "timeout", needsAuth: "claude" })
    expect(auth.ok).toBe(false)
    expect(auth.error).toContain("sign-in")
    const ended = readyVerdict({ ...base, met: false, reason: "ended" })
    expect(ended.ok).toBe(false)
    expect(ended.error).toContain("did not become ready")
    const timeout = readyVerdict({ ...base, met: false, reason: "timeout", message: "30s" })
    expect(timeout.ok).toBe(false)
    expect(timeout.error).toContain("timeout: 30s")
  })
})

describe("agentSessionFromStatus (terminal.status → session id)", () => {
  const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  it("reads status.agentSession from the handler's { status } envelope", () => {
    expect(agentSessionFromStatus({ status: { agentSession: id }, woke: "sleeping" })).toBe(id)
  })
  it("tolerates a flat shape and trims", () => {
    expect(agentSessionFromStatus({ agentSession: ` ${id}\n` })).toBe(id)
  })
  it("returns null for a fresh pane (empty/null/missing) without throwing", () => {
    expect(agentSessionFromStatus({ status: { agentSession: "" } })).toBeNull()
    expect(agentSessionFromStatus({ status: { agentSession: null } })).toBeNull()
    expect(agentSessionFromStatus({ status: {} })).toBeNull()
    expect(agentSessionFromStatus(undefined)).toBeNull()
  })
  it("rejects ids that are not safe to put on a command line", () => {
    expect(agentSessionFromStatus({ status: { agentSession: "rm -rf /; echo" } })).toBeNull()
  })
})

describe("single-flight open (CCR-REQ-2)", () => {
  // The race: runner.terminalId is written only after the ready wait, so a
  // second start for the same task (autoplay retry, manual start-node after a
  // client timeout) used to open another terminal.
  function harness() {
    const runner = new ClaudeCodeRunner({} as never)
    const calls: string[] = []
    const gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
    ;(runner as unknown as { openOnce: (...a: unknown[]) => Promise<TodoNode> }).openOnce = (
      _kind,
      _ws,
      node,
    ) => {
      calls.push((node as TodoNode).nodeId)
      return new Promise<TodoNode>((resolve, reject) => {
        gates.push({ resolve: () => resolve(node as TodoNode), reject })
      })
    }
    return { runner, calls, gates }
  }

  it("[CCR-AC-1] a start while another for the same task is booting joins it", async () => {
    const { runner, calls, gates } = harness()
    const a = runner.startTask("ws_1", task(), "ag_1", "u_1")
    await new Promise((r) => setTimeout(r, 5)) // the scheduler's retry, mid-boot
    const b = runner.startTask("ws_1", task(), "ag_1", "u_1")
    expect(calls).toEqual(["tn_task1"])
    gates[0].resolve()
    const [ra, rb] = await Promise.all([a, b])
    expect(rb).toBe(ra)
  })

  it("[CCR-AC-1] different tasks do not block each other", async () => {
    const { runner, calls } = harness()
    void runner.startTask("ws_1", task(), "ag_1", "u_1")
    void runner.startTask("ws_1", task({ nodeId: "tn_task2" }), "ag_1", "u_1")
    expect(calls).toEqual(["tn_task1", "tn_task2"])
  })

  it("[CCR-AC-1] after a failed boot the next start opens again", async () => {
    const { runner, calls, gates } = harness()
    const a = runner.startTask("ws_1", task(), "ag_1", "u_1")
    gates[0].reject(new Error("ready timeout"))
    await expect(a).rejects.toThrow("ready timeout")
    void runner.startTask("ws_1", task(), "ag_1", "u_1")
    expect(calls).toHaveLength(2)
  })

  it("[CCR-AC-1] after a completed boot the next start opens again (it reuses the live terminal)", async () => {
    const { runner, calls, gates } = harness()
    const a = runner.startTask("ws_1", task(), "ag_1", "u_1")
    gates[0].resolve()
    await a
    void runner.startTask("ws_1", task(), "ag_1", "u_1")
    expect(calls).toHaveLength(2)
  })
})

describe("effectiveKickoff (CCR-REQ-2, CCR-REQ-8)", () => {
  it("[CCR-AC-1] reusing a live terminal never re-sends the brief: it degrades to none", () => {
    expect(effectiveKickoff("brief", true)).toBe("none")
  })

  it("[CCR-AC-1] a new session keeps the full brief", () => {
    expect(effectiveKickoff("brief", false)).toBe("brief")
  })

  it("[CCR-AC-1] explicit kick-offs (human reopen: resume-note / none) are untouched either way", () => {
    for (const reuse of [true, false]) {
      expect(effectiveKickoff("resume-note", reuse)).toBe("resume-note")
      expect(effectiveKickoff("none", reuse)).toBe("none")
    }
  })
})

describe("RUNNER_CWD — the single boot cwd (Pablo, 2-nov)", () => {
  it("is /workspace: every runner session — fresh or resumed — boots there", () => {
    expect(RUNNER_CWD).toBe("/workspace")
  })

  it("a resume launch never changes the boot cwd: same options as a fresh one plus --resume", () => {
    const base = {
      mcpUrl: "http://host.docker.internal:3000/mcp/tasks",
      token: TOKEN,
      nodeId: "tn_task1",
      systemPrompt: "contract",
    }
    // The cwd of the open is the terminal.create payload's, not the launch
    // options' — resumeLaunch must not smuggle a directory anywhere.
    const fresh = runnerLaunch(base)
    const resumed = resumeLaunch({ ...base, sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })
    expect(JSON.stringify(resumed)).not.toMatch(/workspace\/teros|--cwd|\bcd\b/)
    expect(resumed.args).toEqual([...fresh.args, "--resume", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"])
  })
})

describe("resume fallback + watch resilience (31-oct / 2-nov incidents)", () => {
  it("a failed --resume boot falls back to a fresh session", () => {
    expect(shouldFallbackToFresh(true, new Error("terminal.wait: Claude Code did not become ready (timeout)"))).toBe(true)
  })
  it("a fresh boot failure is not retried (no loop)", () => {
    expect(shouldFallbackToFresh(false, new Error("timeout"))).toBe(false)
  })
  it("a missing sign-in is not retried fresh either", () => {
    expect(shouldFallbackToFresh(true, new Error("Claude Code needs a sign-in in the terminal (login)"))).toBe(false)
  })
  it("only a vanished terminal is final for the watch; INTERNAL_ERROR is transient", () => {
    expect(isTerminalGone(new Error("terminal.wait: TERMINAL_NOT_FOUND x"))).toBe(true)
    expect(isTerminalGone(new Error("terminal.wait: INTERNAL_ERROR boom"))).toBe(false)
  })
})

describe("running flag for the Todo row dot (TODOAP-REQ-8/20 parity)", () => {
  function fake() {
    const updates: Array<{ filter: Record<string, unknown>; update: Record<string, any> }> = []
    const broadcasts: string[] = []
    const db = {
      collection: () => ({
        findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, any>) => {
          updates.push({ filter, update })
          return { nodeId: "tn_task1", running: update.$set.running }
        },
      }),
    }
    const runner = new ClaudeCodeRunner({
      db,
      broadcast: async (_ws: string, n: { running: boolean }) => void broadcasts.push(String(n.running)),
    } as never)
    return { runner, updates, broadcasts }
  }

  it("start: running=true only guarded on a working task that is not already running", async () => {
    const { runner, updates, broadcasts } = fake()
    await runner.setRunning("ws_1", "tn_task1", true)
    expect(updates[0].update.$set.running).toBe(true)
    expect(updates[0].filter.state).toBe("working")
    expect(updates[0].filter.running).toEqual({ $ne: true })
    expect(broadcasts).toEqual(["true"])
  })

  it("stop: running=false guarded by the session's terminal so a stale watch cannot clear a newer one", async () => {
    const { runner, updates, broadcasts } = fake()
    await runner.setRunning("ws_1", "tn_task1", false, "term_ccr_x")
    expect(updates[0].update.$set.running).toBe(false)
    expect(updates[0].filter["runner.terminalId"]).toBe("term_ccr_x")
    expect(updates[0].filter.running).toBe(true)
    expect(broadcasts).toEqual(["false"])
  })

  it("hasWatch is false when no watch follows the task", () => {
    expect(new ClaudeCodeRunner({} as never).hasWatch("tn_task1")).toBe(false)
  })
})
