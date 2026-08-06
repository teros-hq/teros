/**
 * Unit tests for the tool-execution proxy meta-tools
 *:
 *
 *   - `list-installed-apps` / `list-app-tools` — local reads, always allowed.
 *   - `execute-tool` — resolves `{app, tool}` to the namespaced tool name and
 *     re-enters `executeTool`, so the TARGET tool runs through the exact same
 *     permission gate as a direct call (allow / ask / forbid / alwaysAsk clamp).
 *   - `getTools()` — injects the meta-tools and omits tools of apps with
 *     `toolExposure: 'proxy'`, while keeping them executable.
 *
 * Pattern (same as enforce-permission-policy.test.ts): a real McaToolExecutor
 * over mocked McaManager + McaService, initialized for real so the proxy's
 * cache-refresh path works.
 */

import { describe, expect, it, mock } from "bun:test"
import {
  PROXY_TOOL_EXECUTE,
  PROXY_TOOL_LIST_APP_TOOLS,
  PROXY_TOOL_LIST_APPS,
} from "../../src/services/agent-proxy-tools"
import type { McaManager } from "../../src/services/mca-manager"
import type { McaService } from "../../src/services/mca-service"
import { McaToolExecutor } from "../../src/services/mca-tool-executor"

const AGENT = "agent_test"
const CHANNEL = "ch_test"

const APP_GRANOLA = "app_granola"
const APP_FS = "app_fs"

// No toolExposure field — proxied by DEFAULT while the proxy is enabled.
function granolaApp(overrides: Record<string, any> = {}) {
  return {
    appId: APP_GRANOLA,
    mcaId: "mca.granola",
    name: "granola",
    permissions: {
      tools: {
        "list-meetings": "allow",
        "delete-meeting": "ask",
        "export-notes": "allow", // alwaysAsk annotation clamps this to ask
      },
      defaultPermission: "ask",
    },
    ...overrides,
  }
}

// Pinned 'direct' — the per-app opt-out from the proxy.
function fsApp() {
  return {
    appId: APP_FS,
    mcaId: "mca.teros.filesystem",
    name: "fs",
    toolExposure: "direct",
    permissions: { tools: { "read-file": "allow" }, defaultPermission: "ask" },
  }
}

const GRANOLA_TOOLS = [
  {
    name: "granola_list-meetings",
    description: "List recent meetings",
    input_schema: { type: "object" as const, properties: { limit: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "granola_delete-meeting",
    description: "Delete a meeting",
    input_schema: {
      type: "object" as const,
      properties: { meetingId: { type: "string" } },
      required: ["meetingId"],
    },
    annotations: { readOnlyHint: false, irreversible: true },
  },
  {
    name: "granola_export-notes",
    description: "Export notes to an external destination",
    input_schema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: false, alwaysAsk: true },
  },
  {
    name: "granola_-health-check",
    description: "Internal health check",
    input_schema: { type: "object" as const, properties: {} },
  },
]

const FS_TOOLS = [
  {
    name: "fs_read-file",
    description: "Read a file",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
]

function makeMocks(opts: { granolaOverrides?: Record<string, any> } = {}) {
  const granola = granolaApp(opts.granolaOverrides)
  const fs = fsApp()
  const appsById: Record<string, any> = { [APP_GRANOLA]: granola, [APP_FS]: fs }

  const mcaManager = {
    registerApp: mock(async () => undefined),
    getToolsForApp: mock(async (appId: string) => ({
      tools: appId === APP_GRANOLA ? GRANOLA_TOOLS : FS_TOOLS,
      status: "standby" as const,
    })),
    executeTool: mock(async () => ({ output: '{"ok":true}', isError: false })),
    getMcaIdForTool: mock((toolName: string) =>
      toolName.startsWith("granola_") ? "mca.granola" : "mca.teros.filesystem",
    ),
  } as unknown as McaManager

  const mcaService = {
    getAgentApps: mock(async () => ({
      agentId: AGENT,
      apps: [
        {
          app: { ...granola, mca: { mcaId: "mca.granola", description: "Meeting notes" } },
          access: {},
        },
        { app: { ...fs, mca: { mcaId: "mca.teros.filesystem" } }, access: {} },
      ],
    })),
    getApp: mock(async (appId: string) => appsById[appId] ?? null),
    hasAccess: mock(async () => true),
  } as unknown as McaService

  return { mcaManager, mcaService }
}

async function buildExecutor(
  opts: {
    granolaOverrides?: Record<string, any>
    onAskPermission?: ReturnType<typeof mock>
    proxyEnabled?: boolean
  } = {},
) {
  const { mcaManager, mcaService } = makeMocks(opts)
  const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
    workspaceId: "work_test",
    onAskPermission: opts.onAskPermission as any,
  })
  await exec.initialize()
  exec.setUserContext("user_human", "work_test", "human")
  // The `tools.execution-proxy` flag is pushed by MessageHandler.getToolExecutor
  // in production; tests enable it directly unless testing the off state.
  exec.setProxyEnabled(opts.proxyEnabled ?? true)
  return { exec, mcaManager, mcaService }
}

describe("tool-execution proxy — getTools() exposure", () => {
  it("injects the three meta-tools ahead of app tools", async () => {
    const { exec } = await buildExecutor()
    const names = exec.getTools().map((t) => t.name)

    expect(names.slice(0, 3)).toEqual([
      PROXY_TOOL_LIST_APPS,
      PROXY_TOOL_LIST_APP_TOOLS,
      PROXY_TOOL_EXECUTE,
    ])
  })

  it("proxies apps by default (no toolExposure field) and honors the 'direct' opt-out pin", async () => {
    const { exec } = await buildExecutor()
    const names = exec.getTools().map((t) => t.name)

    expect(names).toContain("fs_read-file") // pinned 'direct'
    expect(names.some((n) => n.startsWith("granola_"))).toBe(false) // default → proxied
  })

  it("an app pinned 'direct' lists everything alongside the meta-tools", async () => {
    const { exec } = await buildExecutor({ granolaOverrides: { toolExposure: "direct" } })
    const names = exec.getTools().map((t) => t.name)

    expect(names).toContain("granola_list-meetings")
    expect(names).toContain("fs_read-file")
    expect(names).toContain(PROXY_TOOL_EXECUTE)
  })

  it("bakes the installed-apps summary into the execute-tool description (stable data only)", async () => {
    const { exec } = await buildExecutor()
    const executeTool = exec.getTools().find((t) => t.name === PROXY_TOOL_EXECUTE)

    expect(executeTool).toBeDefined()
    expect(executeTool!.description).toContain("Your installed apps:")
    expect(executeTool!.description).toContain("- granola — Meeting notes (3 tools)")
    expect(executeTool!.description).toContain("- fs (1 tools) [tools listed directly]")
    // No volatile status in the summary — it would bust the prompt cache.
    expect(executeTool!.description).not.toContain("standby")
  })

  it("proxied tools stay executable by their namespaced name (exposure ≠ permissions)", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool("granola_list-meetings", {})

    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls[0][0]).toBe("granola_list-meetings")
  })
})

describe("tool-execution proxy — feature flag off (tools.execution-proxy=false)", () => {
  it("injects no meta-tools and ignores toolExposure (everything direct)", async () => {
    const { exec } = await buildExecutor({ proxyEnabled: false })
    const names = exec.getTools().map((t) => t.name)

    expect(names).not.toContain(PROXY_TOOL_LIST_APPS)
    expect(names).not.toContain(PROXY_TOOL_EXECUTE)
    expect(names).toContain("granola_list-meetings") // proxy exposure ignored
    expect(names).toContain("fs_read-file")
  })

  it("meta-tool calls fall through to the standard does-not-exist rejection", async () => {
    const { exec, mcaManager } = await buildExecutor({ proxyEnabled: false })

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, { app: "granola", tool: "list-meetings" })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("does not exist")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("setProxyEnabled(true) on a live executor turns the proxy on without reinitializing", async () => {
    const { exec } = await buildExecutor({ proxyEnabled: false })

    exec.setProxyEnabled(true)
    const names = exec.getTools().map((t) => t.name)

    expect(names).toContain(PROXY_TOOL_EXECUTE)
    expect(names.some((n) => n.startsWith("granola_"))).toBe(false)
  })
})

describe("tool-execution proxy — list-installed-apps", () => {
  it("returns app, status, public tool count and exposure per app", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APPS, {})
    expect(r.isError).toBe(false)
    const { apps } = JSON.parse(r.output)

    const granola = apps.find((a: any) => a.app === "granola")
    expect(granola).toMatchObject({
      appId: APP_GRANOLA,
      mcaId: "mca.granola",
      description: "Meeting notes",
      status: "standby",
      toolCount: 3, // -health-check excluded
      exposure: "proxy",
    })

    const fs = apps.find((a: any) => a.app === "fs")
    expect(fs).toMatchObject({ appId: APP_FS, toolCount: 1, exposure: "direct" })
  })
})

describe("tool-execution proxy — list-app-tools", () => {
  it("compact list: short names, description, effective permission, flags — no schemas", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APP_TOOLS, { app: "granola" })
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.output)

    expect(parsed.app).toBe("granola")
    const names = parsed.tools.map((t: any) => t.name)
    expect(names).toEqual(["list-meetings", "delete-meeting", "export-notes"])

    const list = parsed.tools.find((t: any) => t.name === "list-meetings")
    expect(list).toMatchObject({ permission: "allow", readOnly: true })
    expect(list.inputSchema).toBeUndefined()

    const del = parsed.tools.find((t: any) => t.name === "delete-meeting")
    expect(del).toMatchObject({ permission: "ask", irreversible: true })

    // alwaysAsk clamps the configured 'allow' down to 'ask' in the report too
    const exp = parsed.tools.find((t: any) => t.name === "export-notes")
    expect(exp).toMatchObject({ permission: "ask", alwaysAsk: true })
  })

  it("expands requested tools with their input schemas and reports unknown names", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APP_TOOLS, {
      app: APP_GRANOLA, // appId works as app ref too
      tools: ["delete-meeting", "nope"],
    })
    const parsed = JSON.parse(r.output)

    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].name).toBe("delete-meeting")
    expect(parsed.tools[0].inputSchema).toMatchObject({
      type: "object",
      required: ["meetingId"],
    })
    expect(parsed.unknownTools).toEqual(["nope"])
  })

  it("unknown app returns an error listing installed apps", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APP_TOOLS, { app: "slack" })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("No installed app matches 'slack'")
    expect(r.output).toContain("granola")
  })
})

describe("tool-execution proxy — execute-tool permission transparency", () => {
  it("target with 'allow' executes against the MCA with the namespaced name and target input", async () => {
    const ask = mock(async () => "granted" as const)
    const { exec, mcaManager } = await buildExecutor({ onAskPermission: ask })

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: { limit: 5 },
    })

    expect(r.isError).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    expect(call[1]).toEqual({ limit: 5 })
    expect(call[2]).toMatchObject({ appId: APP_GRANOLA, agentId: AGENT })
  })

  it("target with 'ask' triggers the ask flow with the TARGET tool name, appId and irreversible flag", async () => {
    const ask = mock(async () => "granted" as const)
    const { exec, mcaManager } = await buildExecutor({ onAskPermission: ask })

    const r = await exec.executeTool(
      PROXY_TOOL_EXECUTE,
      { app: "granola", tool: "delete-meeting", input: { meetingId: "m1" } },
      { toolCallId: "tc_1" },
    )

    expect(r.isError).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    const [toolName, appId, input, irreversible, toolCallId] = (ask as any).mock.calls[0]
    expect(toolName).toBe("granola_delete-meeting")
    expect(appId).toBe(APP_GRANOLA)
    expect(input).toEqual({ meetingId: "m1" })
    expect(irreversible).toBe(true)
    expect(toolCallId).toBe("tc_1")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(1)
  })

  it("user denial blocks execution", async () => {
    const ask = mock(async () => "denied" as const)
    const { exec, mcaManager } = await buildExecutor({ onAskPermission: ask })

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: { meetingId: "m1" },
    })

    expect(r.isError).toBe(true)
    expect(r.permissionDenied).toBe(true)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("alwaysAsk clamp survives the proxy: configured 'allow' still asks", async () => {
    const ask = mock(async () => "granted" as const)
    const { exec } = await buildExecutor({ onAskPermission: ask })

    await exec.executeTool(PROXY_TOOL_EXECUTE, { app: "granola", tool: "export-notes" })

    expect(ask).toHaveBeenCalledTimes(1)
    expect((ask as any).mock.calls[0][0]).toBe("granola_export-notes")
  })

  it("target with 'forbid' is denied without asking", async () => {
    const ask = mock(async () => "granted" as const)
    const { exec, mcaManager } = await buildExecutor({
      onAskPermission: ask,
      granolaOverrides: {
        toolExposure: "proxy",
        permissions: { tools: { "delete-meeting": "forbid" }, defaultPermission: "ask" },
      },
    })

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: { meetingId: "m1" },
    })

    expect(r.isError).toBe(true)
    expect(r.permissionDenied).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })
})

describe("tool-execution proxy — execute-tool resolution", () => {
  it("accepts appId as app ref and underscore tool names (normalized to kebab)", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: APP_GRANOLA,
      tool: "list_meetings",
    })

    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls[0][0]).toBe("granola_list-meetings")
  })

  it("accepts an already-namespaced tool name", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "granola_list-meetings",
    })

    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls[0][0]).toBe("granola_list-meetings")
  })

  it("unknown tool returns a discovery hint, not an MCA call", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, { app: "granola", tool: "nope" })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("App 'granola' has no tool 'nope'")
    expect(r.output).toContain(PROXY_TOOL_LIST_APP_TOOLS)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("missing app/tool params return validation errors", async () => {
    const { exec } = await buildExecutor()

    const noApp = await exec.executeTool(PROXY_TOOL_EXECUTE, { tool: "x" })
    expect(noApp.isError).toBe(true)
    expect(noApp.output).toContain("'app' is required")

    const noTool = await exec.executeTool(PROXY_TOOL_EXECUTE, { app: "granola" })
    expect(noTool.isError).toBe(true)
    expect(noTool.output).toContain("'tool' is required")
  })

  it("resolveProxyExecution tunnels execute-tool to the target name, mcaId and inner input", async () => {
    const { exec } = await buildExecutor()

    const tunneled = exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list_meetings",
      input: { limit: 5 },
    })

    expect(tunneled).toEqual({
      toolName: "granola_list-meetings",
      mcaId: "mca.granola",
      input: { limit: 5 },
    })
  })

  it("resolveProxyExecution returns null for non-execute tools, unknown targets and proxy off", async () => {
    const { exec } = await buildExecutor()

    expect(exec.resolveProxyExecution("granola_list-meetings", {})).toBeNull()
    expect(exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, { app: "granola", tool: "nope" })).toBeNull()
    expect(exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, { app: "slack", tool: "x" })).toBeNull()
    expect(exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, { app: "granola" })).toBeNull()

    exec.setProxyEnabled(false)
    expect(
      exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, { app: "granola", tool: "list-meetings" }),
    ).toBeNull()
  })

  it("meta-tools cannot be proxied into themselves (no recursion)", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: PROXY_TOOL_EXECUTE,
    })

    expect(r.isError).toBe(true)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })
})
