/**
 * Unit tests for the tool-execution proxy meta-tools
 * (docs/specs/20260704_tool-execution-proxy.md):
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
import { isDiscoveryMetaTool, isProgressNoteTool, PROXY_TOOL_NAMES } from "@teros/shared"

const AGENT = "agent_test"
const CHANNEL = "ch_test"

// C3a fixtures: unsubstituted GLM/Zhipu template placeholders that leak into
// proxied tool-call arguments (built by concatenation so this file never
// carries the literal tag sequences that corrupt tool-call serialization).
const ARG_VALUE_TAG = "<" + "arg_" + "value"
const ARG_KEY_TAG = "<" + "arg_" + "key"

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
    // MUW-REQ-12: no channel document behind CHANNEL in these suites — a null
    // viewer keeps the executor's own user context (set via setUserContext).
    getChannelViewer: mock(async () => null),
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
    // mca.teros.filesystem is a system-capability MCA: its tools are already flat
    // in the tool list, so buildInstalledAppsSummary leaves it out (noise, not signal).
    expect(executeTool!.description).not.toContain("- fs (")
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

  it("C1: tool nested inside input (top-level missing) executes the target and strips the stray 'tool' param", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      input: { limit: 5, tool: "list-meetings" }, // tool nested, top-level absent
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    // The stray nested 'tool' must NOT reach the target tool's input.
    expect(call[1]).toEqual({ limit: 5 })
  })

  it("C1: tool nested inside a JSON-string input is recovered too", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      input: JSON.stringify({ limit: 7, tool: "list_meetings" }),
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    expect(call[1]).toEqual({ limit: 7 })
  })

  it("C1: no tool anywhere still fails with the 'tool' is required error", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      input: { limit: 5 }, // no top-level tool, no nested tool
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("'tool' is required")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("C1: top-level tool wins; a matching stray nested copy is stripped", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: { limit: 3, tool: "list-meetings" }, // duplicated in both places
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    expect(call[1]).toEqual({ limit: 3 })
  })

  it("C1: resolveProxyExecution tunnels a nested-tool call like the execution path", async () => {
    const { exec } = await buildExecutor()

    const tunneled = exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, {
      app: "granola",
      input: { limit: 9, tool: "list-meetings" },
    })

    expect(tunneled).toEqual({
      toolName: "granola_list-meetings",
      mcaId: "mca.granola",
      input: { limit: 9 },
    })
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

describe("tool-execution proxy — execute-tool input coercion (string → object)", () => {
  it("nested input as valid JSON string → reaches the target with the right args", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: JSON.stringify({ limit: 5 }),
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    expect(call[1]).toEqual({ limit: 5 })
  })

  it("nested input as malformed string → error mentions parse failure, target NOT called", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: "{limit: 5,}", // malformed JSON
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("could not be parsed")
    expect(r.output).toContain("list-meetings")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("C3a: unsubstituted value placeholder in string input → specific error, not generic parse error", async () => {
    const { exec, mcaManager } = await buildExecutor()
    // Real production shape (ch_57aaead7c1ee50ab): the value placeholder
    // leaked into the serialized arguments and never got substituted.
    const corrupted = '{"limit":' + ARG_VALUE_TAG + '5}'

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: corrupted,
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("unsubstituted serialization placeholder")
    expect(r.output).toContain("regenerate the complete call")
    expect(r.output).not.toContain("could not be parsed")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("C3a: key placeholder variant is detected too", async () => {
    const { exec, mcaManager } = await buildExecutor()
    const corrupted = '{' + ARG_KEY_TAG + 'limit": 5}'

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: corrupted,
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("unsubstituted serialization placeholder")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("C3a: valid JSON that merely mentions the tag word in prose is NOT flagged", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: JSON.stringify({ limit: 5, note: "docs about arg_value markup" }),
    })

    // 'arg_value' as a plain word (no '<' prefix) must not trigger detection.
    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(1)
  })

  it("C3a: resolveProxyExecution returns null for placeholder-corrupted input", async () => {
    const { exec } = await buildExecutor()
    const corrupted = '{"limit":' + ARG_VALUE_TAG + '5}'

    const tunneled = exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: corrupted,
    })

    expect(tunneled).toBeNull()
  })

  it("nested input as object → unchanged behaviour", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: { limit: 10 },
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[0]).toBe("granola_list-meetings")
    expect(call[1]).toEqual({ limit: 10 })
  })

  it("nested input as array → rejected with clear error, target NOT called", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: [1, 2, 3],
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("list-meetings")
    expect(r.output).toMatch(/array|object/)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("nested input as primitive (number) → rejected with clear error", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: 42,
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("list-meetings")
    expect(r.output).toContain("number")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("nested input as JSON string that parses to array → rejected", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
      input: "[1, 2, 3]",
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("list-meetings")
    expect(r.output).toContain("array")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("absent input → treated as empty object (tools with no required params)", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
    })

    expect(r.isError).toBe(false)
    const call = (mcaManager.executeTool as any).mock.calls[0]
    expect(call[1]).toEqual({})
  })

  it("resolveProxyExecution coerces string input for UI tunneling", async () => {
    const { exec } = await buildExecutor()

    const tunneled = exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list_meetings",
      input: JSON.stringify({ limit: 7 }),
    })

    expect(tunneled).toEqual({
      toolName: "granola_list-meetings",
      mcaId: "mca.granola",
      input: { limit: 7 },
    })
  })

  it("resolveProxyExecution returns null for malformed string input", async () => {
    const { exec } = await buildExecutor()

    const tunneled = exec.resolveProxyExecution(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list_meetings",
      input: "{bad json",
    })

    expect(tunneled).toBeNull()
  })
})

describe("tool-execution proxy — compact listing surfaces required params", () => {
  it("compact list-app-tools includes `required` and `properties` for a tool that has them", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APP_TOOLS, { app: "granola" })
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.output)

    // delete-meeting has required: ["meetingId"]
    const del = parsed.tools.find((t: any) => t.name === "delete-meeting")
    expect(del.required).toEqual(["meetingId"])
    expect(del.properties).toEqual(["meetingId"])

    // list-meetings has NO required params — field should be absent
    const list = parsed.tools.find((t: any) => t.name === "list-meetings")
    expect(list.required).toBeUndefined()
    expect(list.properties).toEqual(["limit"])

    // export-notes has empty properties
    const exp = parsed.tools.find((t: any) => t.name === "export-notes")
    expect(exp.required).toBeUndefined()
    expect(exp.properties).toEqual([])
  })

  it("compact list-app-tools for fs app includes required for read-file", async () => {
    const { exec } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_LIST_APP_TOOLS, { app: "fs" })
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.output)

    const readFile = parsed.tools.find((t: any) => t.name === "read-file")
    expect(readFile.required).toEqual(["path"])
    expect(readFile.properties).toEqual(["path"])
  })
})

describe("tool-execution proxy — execute-tool pre-flight required-param validation", () => {
  it("missing required param returns a precise error naming the field, target NOT called", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: {}, // meetingId is required
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("missing required parameter")
    expect(r.output).toContain("'meetingId'")
    expect(r.output).toContain("delete-meeting")
    expect(r.output).toContain(PROXY_TOOL_LIST_APP_TOOLS)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("missing one of multiple required params names only the missing one", async () => {
    // Add a tool with two required params to the granola mock via a custom build
    const { mcaManager, mcaService } = makeMocks()
    // Override getToolsForApp to include a tool with two required params
    ;(mcaManager as any).getToolsForApp = mock(async (appId: string) => ({
      tools: appId === APP_GRANOLA
        ? [
            ...GRANOLA_TOOLS,
            {
              name: "granola_create-meeting",
              description: "Create a meeting",
              input_schema: {
                type: "object" as const,
                properties: {
                  title: { type: "string" },
                  date: { type: "string" },
                },
                required: ["title", "date"],
              },
            },
          ]
        : FS_TOOLS,
      status: "standby" as const,
    }))
    const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
      workspaceId: "work_test",
    })
    await exec.initialize()
    exec.setUserContext("user_human", "work_test", "human")
    exec.setProxyEnabled(true)

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "create-meeting",
      input: { title: "Sync" }, // date is missing
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("missing required parameter")
    expect(r.output).toContain("'date'")
    expect(r.output).not.toContain("'title'")
    expect((mcaManager as any).executeTool.mock.calls).toHaveLength(0)
  })

  it("all required params present → executes normally (no false positive)", async () => {
    const ask = mock(async () => "granted" as const)
    const { exec, mcaManager } = await buildExecutor({ onAskPermission: ask })

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: { meetingId: "m1" },
    })

    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(1)
  })

  it("tool with no required params → no validation error (absent input)", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "list-meetings",
    })

    expect(r.isError).toBe(false)
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(1)
  })

  it("empty string for a required param is treated as missing", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: { meetingId: "" },
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("'meetingId'")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("null for a required param is treated as missing", async () => {
    const { exec, mcaManager } = await buildExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "granola",
      tool: "delete-meeting",
      input: { meetingId: null },
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("'meetingId'")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Explicit null on a schema-nullable required param (fb_3083851078d1474c)
//
// todo-list plan-node declares `day: { type: ["string", "null"] }` with
// `required: ["nodeId", "day"]` — `day: null` is the DOCUMENTED call that
// removes the task from its day. The pre-flight must let it through to the
// MCA instead of rejecting it as "missing required parameter".
// ---------------------------------------------------------------------------
describe("tool-execution proxy — explicit null on a nullable required param", () => {
  // Mirrors mca.teros.todo-list tools.json plan-node (only the fields the
  // proxy reads: properties + required).
  const TODO_TOOLS = [
    {
      name: "todo-list_plan-node",
      description: "Plan a task for a calendar day, or take it off its day",
      input_schema: {
        type: "object" as const,
        properties: {
          nodeId: { type: "string", description: "Task node ID." },
          day: { type: ["string", "null"], description: 'Day "YYYY-MM-DD", or null to remove the task from its day.' },
          index: { type: "integer", minimum: 0, description: "Position in the day's plan (0-based). Optional." },
          time: { type: ["string", "null"], description: 'Planned time "HH:MM" (24 h), or null to clear it. Optional.' },
        },
        required: ["nodeId", "day"],
      },
    },
  ]

  function makeTodoMocks() {
    const app = {
      appId: "app_todo",
      mcaId: "mca.teros.todo-list",
      name: "todo-list",
      permissions: {
        tools: { "plan-node": "allow" },
        defaultPermission: "ask",
      },
    }
    const appsById: Record<string, any> = { app_todo: app }

    const mcaManager = {
      registerApp: mock(async () => undefined),
      getToolsForApp: mock(async (appId: string) => ({
        tools: appId === "app_todo" ? TODO_TOOLS : [],
        status: "standby" as const,
      })),
      executeTool: mock(async () => ({ output: '{"ok":true}', isError: false })),
      getMcaIdForTool: mock((toolName: string) =>
        toolName.startsWith("todo-list_") ? "mca.teros.todo-list" : undefined,
      ),
    } as unknown as McaManager

    const mcaService = {
      getAgentApps: mock(async () => ({
        agentId: AGENT,
        apps: [
          {
            app: { ...app, mca: { mcaId: "mca.teros.todo-list", description: "Todo list" } },
            access: {},
          },
        ],
      })),
      getApp: mock(async (appId: string) => appsById[appId] ?? null),
      hasAccess: mock(async () => true),
      // MUW-REQ-12: no channel document behind CHANNEL in these suites — a null
      // viewer keeps the executor's own user context (set via setUserContext).
      getChannelViewer: mock(async () => null),
    } as unknown as McaService

    return { mcaManager, mcaService }
  }

  async function buildTodoExecutor() {
    const { mcaManager, mcaService } = makeTodoMocks()
    const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
      workspaceId: "work_test",
    })
    await exec.initialize()
    exec.setUserContext("user_human", "work_test", "human")
    exec.setProxyEnabled(true)
    return { exec, mcaManager }
  }

  it("plan-node with day: null reaches the MCA (documented un-plan call)", async () => {
    const { exec, mcaManager } = await buildTodoExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: { nodeId: "tn_abc", day: null },
    })

    expect(r.isError).toBe(false)
    // The call must reach the MCA exactly once, under the namespaced name,
    // with the explicit null preserved verbatim.
    const calls = (mcaManager.executeTool as any).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("todo-list_plan-node")
    expect(calls[0][1]).toEqual({ nodeId: "tn_abc", day: null })
  })

  it("plan-node with a non-null day still works (regression guard)", async () => {
    const { exec, mcaManager } = await buildTodoExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: { nodeId: "tn_abc", day: "2026-10-28" },
    })

    expect(r.isError).toBe(false)
    const calls = (mcaManager.executeTool as any).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({ nodeId: "tn_abc", day: "2026-10-28" })
  })

  it("null on a NON-nullable required param is still rejected as missing", async () => {
    const { exec, mcaManager } = await buildTodoExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: { nodeId: null, day: "2026-10-28" }, // nodeId is type: "string" — null not accepted
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain("missing required parameter")
    expect(r.output).toContain("'nodeId'")
    expect(r.output).not.toContain("'day'")
    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("undefined and empty string remain missing even on a nullable param", async () => {
    const { exec, mcaManager } = await buildTodoExecutor()

    const undefinedCase = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: { nodeId: "tn_abc" }, // day absent
    })
    expect(undefinedCase.isError).toBe(true)
    expect(undefinedCase.output).toContain("'day'")

    const emptyCase = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: { nodeId: "tn_abc", day: "" }, // empty string
    })
    expect(emptyCase.isError).toBe(true)
    expect(emptyCase.output).toContain("'day'")

    expect((mcaManager.executeTool as any).mock.calls).toHaveLength(0)
  })

  it("nullable param passed as a JSON string input still reaches the MCA (coercion path)", async () => {
    const { exec, mcaManager } = await buildTodoExecutor()

    const r = await exec.executeTool(PROXY_TOOL_EXECUTE, {
      app: "todo-list",
      tool: "plan-node",
      input: JSON.stringify({ nodeId: "tn_abc", day: null }),
    })

    expect(r.isError).toBe(false)
    const calls = (mcaManager.executeTool as any).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({ nodeId: "tn_abc", day: null })
  })
})


describe("shared helpers — isProgressNoteTool / isDiscoveryMetaTool", () => {
  it("isProgressNoteTool: true for direct namespaced name", () => {
    expect(isProgressNoteTool("board-runner_add-progress-note")).toBe(true)
    expect(isProgressNoteTool("board-manager_add-progress-note")).toBe(true)
  })

  it("isProgressNoteTool: true for proxied execute-tool with input.tool=add-progress-note", () => {
    expect(
      isProgressNoteTool(PROXY_TOOL_NAMES.execute, {
        app: "board-runner",
        tool: "add-progress-note",
        input: { taskId: "t1", text: "progress" },
      }),
    ).toBe(true)
  })

  it("isProgressNoteTool: false for proxied execute-tool with a non-note tool", () => {
    expect(
      isProgressNoteTool(PROXY_TOOL_NAMES.execute, {
        app: "some-host-app",
        tool: "bash",
        input: { command: "ls" },
      }),
    ).toBe(false)
  })

  it("isProgressNoteTool: false for unrelated tool names", () => {
    expect(isProgressNoteTool("search")).toBe(false)
    expect(isProgressNoteTool("list-installed-apps")).toBe(false)
    expect(isProgressNoteTool("execute-tool")).toBe(false) // no input → false
  })

  it("isProgressNoteTool: false for execute-tool with no input", () => {
    expect(isProgressNoteTool(PROXY_TOOL_NAMES.execute)).toBe(false)
    expect(isProgressNoteTool(PROXY_TOOL_NAMES.execute, null)).toBe(false)
    expect(isProgressNoteTool(PROXY_TOOL_NAMES.execute, undefined)).toBe(false)
  })

  it("isDiscoveryMetaTool: true for list-installed-apps and list-app-tools", () => {
    expect(isDiscoveryMetaTool("list-installed-apps")).toBe(true)
    expect(isDiscoveryMetaTool("list-app-tools")).toBe(true)
  })

  it("isDiscoveryMetaTool: false for execute-tool and other names", () => {
    expect(isDiscoveryMetaTool("execute-tool")).toBe(false)
    expect(isDiscoveryMetaTool("search")).toBe(false)
    expect(isDiscoveryMetaTool("board-runner_add-progress-note")).toBe(false)
  })
})
