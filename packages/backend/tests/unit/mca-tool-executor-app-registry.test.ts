/**
 * Unit tests — McaToolExecutor app-registry self-heal (incident 2026-10-31,
 * task task_13bb25c341825d20).
 *
 * updateToolCache() re-derives the app set from mcaService.getAgentApps()
 * instead of trusting the construction-time `appIds` snapshot, so every
 * cache rebuild converges to the agent's CURRENT access:
 *
 *   - install-mid-conversation: an app granted after the executor was built
 *     becomes resolvable by the proxy (execute-tool / list-app-tools) after
 *     the next rebuild — WITHOUT recreating the executor or the conversation.
 *   - revoke-mid-conversation: an app revoked after the executor was built
 *     disappears from the proxy registry (resolution + execution) after the
 *     next rebuild.
 *
 * The rebuild triggers exercised here are the two production paths that
 * matter for the incident: refresh() (invalidateToolCache → grant/revoke)
 * and the unknown-tool retry inside enforcePermissionPolicy (a tool of a
 * newly-installed app is called by its namespaced name — the LLM remembered
 * it from a previous conversation).
 *
 * Pattern (same as tool-execution-proxy.test.ts): a real McaToolExecutor
 * over mocked McaManager + McaService, initialized for real.
 */

import { describe, expect, it, mock } from "bun:test"
import type { McaManager } from "../../src/services/mca-manager"
import type { McaService } from "../../src/services/mca-service"
import { McaToolExecutor } from "../../src/services/mca-tool-executor"
import { PROXY_TOOL_EXECUTE, PROXY_TOOL_LIST_APPS } from "../../src/services/agent-proxy-tools"

const AGENT = "agent_test"
const CHANNEL = "ch_test"
const WORKSPACE = "work_test"

const APP_A = "app_alpha"
const APP_B = "app_beta" // installed mid-conversation in these tests

function alphaApp() {
  return {
    appId: APP_A,
    mcaId: "mca.teros.alpha",
    name: "alpha",
    permissions: { tools: { "alpha_ping": "allow" }, defaultPermission: "allow" },
  }
}

function betaApp() {
  return {
    appId: APP_B,
    mcaId: "mca.teros.beta",
    name: "beta",
    permissions: { tools: { "beta_ping": "allow" }, defaultPermission: "allow" },
  }
}

const ALPHA_TOOLS = [
  {
    name: "alpha_ping",
    description: "Alpha ping",
    input_schema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
]

const BETA_TOOLS = [
  {
    name: "beta_ping",
    description: "Beta ping",
    input_schema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
]

interface Harness {
  exec: McaToolExecutor
  mcaManager: { registerApp: any; getToolsForApp: any; executeTool: any }
  mcaService: { getAgentApps: any; getApp: any; getChannelViewer?: any; isAppUsableBy?: any }
  setAgentApps: (appIds: string[]) => void
}

/**
 * Build a real executor over mocks whose getAgentApps() returns a mutable
 * roster — the tests mutate it mid-conversation to model install/revoke.
 */
async function buildHarness(initialAppIds: string[]): Promise<Harness> {
  const appsById: Record<string, any> = {
    [APP_A]: alphaApp(),
    [APP_B]: betaApp(),
  }
  let agentAppIds = [...initialAppIds]

  const mcaManager = {
    registerApp: mock(async (appId: string) => {
      // registerApp only matters for apps the manager has not seen; emulate
      // the real manager's map semantics loosely — the executor's rebuild
      // path calls it for newly visible apps.
      void appId
      return null
    }),
    getToolsForApp: mock(async (appId: string) => ({
      tools: appId === APP_A ? ALPHA_TOOLS : BETA_TOOLS,
      status: "standby" as const,
    })),
    executeTool: mock(async (toolName: string) => ({
      output: JSON.stringify({ ok: true, tool: toolName }),
      isError: false,
    })),
    getMcaIdForTool: mock((toolName: string) =>
      toolName.startsWith("alpha_") ? "mca.teros.alpha" : "mca.teros.beta",
    ),
  } as unknown as McaManager

  const mcaService = {
    // MUW-REQ-12: no conversation viewer in these fixtures → the legacy per-agent app set
    getChannelViewer: mock(async () => null),
    isAppUsableBy: () => true,
    getAgentApps: mock(async () => ({
      agentId: AGENT,
      apps: agentAppIds.map((appId) => ({
        app: { ...appsById[appId], mca: { mcaId: appsById[appId].mcaId, description: "test" } },
        access: {},
      })),
    })),
    getApp: mock(async (appId: string) => appsById[appId] ?? null),
    hasAccess: mock(async () => true),
  } as unknown as McaService

  const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
    workspaceId: WORKSPACE,
  })
  await exec.initialize()
  exec.setUserContext("user_human", WORKSPACE, "human")
  exec.setProxyEnabled(true)

  return {
    exec,
    mcaManager: mcaManager as any,
    mcaService: mcaService as any,
    setAgentApps: (appIds: string[]) => {
      agentAppIds = [...appIds]
    },
  }
}

/** Parse the JSON output of a proxy meta-tool result. */
function parseOutput(r: { output: string }): any {
  return JSON.parse(r.output)
}

describe("McaToolExecutor app-registry self-heal — install mid-conversation", () => {
  it("execute-tool resolves an app installed after the executor was built (after refresh)", async () => {
    const h = await buildHarness([APP_A])

    // Before: beta is not installed — resolution fails (the incident symptom).
    const before = await h.exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "beta",
      tool: "ping",
      input: {},
    })
    expect(before.isError).toBe(true)
    expect(before.output).toContain("No installed app matches 'beta'")

    // Mid-conversation: beta is installed + granted (the DB roster changes).
    h.setAgentApps([APP_A, APP_B])

    // invalidateToolCache → executor.refresh() — the production path.
    await h.exec.refresh()

    // After: the proxy resolves beta and the target tool executes.
    const after = await h.exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "beta",
      tool: "ping",
      input: {},
    })
    expect(after.isError).toBe(false)
    const parsed = parseOutput(after)
    expect(parsed.ok).toBe(true)
    expect(h.mcaManager.executeTool.mock.calls.some((c: any[]) => c[0] === "beta_ping")).toBe(true)
  })

  it("list-installed-apps shows the newly installed app after the refresh", async () => {
    const h = await buildHarness([APP_A])
    h.setAgentApps([APP_A, APP_B])
    await h.exec.refresh()

    const r = await h.exec.executeTool(PROXY_TOOL_LIST_APPS, {})
    const parsed = parseOutput(r)
    const names = parsed.apps.map((a: any) => a.app)
    expect(names).toContain("beta")
    expect(names).toContain("alpha")
  })

  it("a namespaced tool of a newly installed app self-heals via the unknown-tool retry (no refresh)", async () => {
    // The LLM calls the tool directly by its remembered namespaced name.
    // enforcePermissionPolicy refreshes the cache once when the tool is not
    // found — with the fix, that rebuild re-derives the app set and the call
    // succeeds even though nobody called refresh().
    const h = await buildHarness([APP_A])
    h.setAgentApps([APP_A, APP_B])

    const r = await h.exec.executeTool("beta_ping", {})
    expect(r.isError).toBe(false)
    expect(h.mcaManager.executeTool.mock.calls.some((c: any[]) => c[0] === "beta_ping")).toBe(true)
  })

  it("newly visible apps are registered with mcaManager during the rebuild", async () => {
    const h = await buildHarness([APP_A])
    h.setAgentApps([APP_A, APP_B])
    await h.exec.refresh()

    // beta was unknown to the manager at construction — the rebuild must
    // have registered it so getToolsForApp could resolve its tools.
    expect(h.mcaManager.registerApp.mock.calls.some((c: any[]) => c[0] === APP_B)).toBe(true)
  })
})

describe("McaToolExecutor app-registry self-heal — revoke mid-conversation (regression)", () => {
  it("a revoked app stops resolving AND stops executing after the refresh", async () => {
    const h = await buildHarness([APP_A, APP_B])

    // Sanity: beta resolves before the revoke.
    const before = await h.exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "beta",
      tool: "ping",
      input: {},
    })
    expect(before.isError).toBe(false)

    // Mid-conversation: beta's access is revoked.
    h.setAgentApps([APP_A])
    await h.exec.refresh()

    // Resolution fails again …
    const resolveAfter = await h.exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "beta",
      tool: "ping",
      input: {},
    })
    expect(resolveAfter.isError).toBe(true)
    expect(resolveAfter.output).toContain("No installed app matches 'beta'")

    // … and direct execution of its remembered namespaced tool is rejected.
    const execAfter = await h.exec.executeTool("beta_ping", {})
    expect(execAfter.isError).toBe(true)
    expect(execAfter.output).toContain("does not exist")
  })

  it("list-installed-apps no longer lists the revoked app", async () => {
    const h = await buildHarness([APP_A, APP_B])
    h.setAgentApps([APP_A])
    await h.exec.refresh()

    const r = await h.exec.executeTool(PROXY_TOOL_LIST_APPS, {})
    const parsed = parseOutput(r)
    const names = parsed.apps.map((a: any) => a.app)
    expect(names).not.toContain("beta")
    expect(names).toContain("alpha")
  })
})
