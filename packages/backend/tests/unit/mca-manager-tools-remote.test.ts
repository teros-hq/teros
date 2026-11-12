/**
 * T-REM-7 — executeToolViaRemote surfaces the actionable offline notice and
 * triggers the channel notifier.
 *
 * The gateway returns a structured MACHINE_UNREACHABLE with
 * `details.diagnostic`; the executor must:
 *   1. Return the actionable message to the LLM (code + message + hint with
 *      the exact `teros-remote` command).
 *   2. Fire-and-forget a `RemoteOfflineNotifier.notifyOffline` call with the
 *      channelId so the *user* sees the notice without depending on the agent.
 *   3. Skip the notifier entirely when no channelId is present (e.g. internal
 *      calls) or when the diagnostic is missing (legacy gateway).
 */

import { describe, expect, it, mock } from "bun:test"
import type { RemoteToolResultPayload } from "@teros/shared"
import { executeToolViaRemote, type ToolsContext } from "../../src/services/mca-manager.tools"
import type { ManagedMca } from "../../src/services/mca-manager.types"
import type { RemoteDeviceGateway } from "../../src/services/remote-device-gateway"
import {
  type RemoteChannelNotification,
  RemoteOfflineNotifier,
} from "../../src/services/remote-offline-notifier"

function makeManagedRemote(overrides: Partial<ManagedMca> = {}): ManagedMca {
  return {
    appId: "app_remote_1",
    mcaId: "mca.teros.remote",
    appName: "midgar",
    client: null,
    transport: null,
    tools: [],
    toolNameMapping: new Map([["midgar_bash", "bash"]]),
    status: "standby",
    lastUsed: new Date(0),
    restartCount: 0,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial
  } as any
}

function makeCtx(overrides: Partial<ToolsContext> = {}): ToolsContext {
  return {
    mcas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    mcaService: { getApp: mock(async () => null) } as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    containerManager: { touch: mock(() => {}) } as any,
    httpClients: new Map(),
    staticToolsCache: new Map(),
    containerBackendHost: "host.docker.internal",
    // biome-ignore lint/suspicious/noExplicitAny: config parcial
    config: { mcaBasePath: "/tmp", serverPort: 10001 } as any,
    getOrSpawn: mock(async () => makeManagedRemote()),
    registerApp: mock(async () => null),
    ...overrides,
  }
}

function offlinePayload(): RemoteToolResultPayload {
  return {
    success: false,
    duration: 0,
    error: {
      code: "MACHINE_UNREACHABLE",
      message:
        "⚠ midgar is offline (last seen 12 min ago). On your machine run: `teros-remote start` (or `teros-remote service status` if installed as a service). The agent will retry automatically when it reconnects.",
      hint: "⚠ midgar is offline (last seen 12 min ago). On your machine run: `teros-remote start` (or `teros-remote service status` if installed as a service). The agent will retry automatically when it reconnects.",
      details: {
        diagnostic: "device_offline",
        appId: "app_remote_1",
        deviceId: "dev_midgar",
        deviceName: "midgar",
        hostname: "midgar.local",
        lastSeenAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        lastSeenHuman: "12 min ago",
      },
    },
  }
}

describe("executeToolViaRemote — T-REM-7 offline UX", () => {
  it("returns the actionable message to the LLM and notifies the channel", async () => {
    const dispatch = mock(async () => offlinePayload())
    const sent: RemoteChannelNotification[] = []
    const notifier = new RemoteOfflineNotifier({
      notify: (n) => {
        sent.push(n)
      },
    })
    const ctx = makeCtx({
      remoteGateway: { dispatch } as unknown as RemoteDeviceGateway,
      remoteOfflineNotifier: notifier,
    })
    const managed = makeManagedRemote()

    const result = await executeToolViaRemote(
      ctx,
      managed,
      "midgar_bash",
      {
        command: "ls",
      },
      {
        channelId: "ch_1",
        agentId: "agent_x",
        appId: "app_remote_1",
      },
    )

    // 1. The LLM gets the structured error with the actionable message.
    expect(result.isError).toBe(true)
    expect(result.mcaId).toBe("mca.teros.remote")
    const parsed = JSON.parse(result.output)
    expect(parsed.error).toBe("MACHINE_UNREACHABLE")
    expect(parsed.message).toContain("midgar is offline")
    expect(parsed.message).toContain("last seen 12 min ago")
    expect(parsed.message).toContain("teros-remote start")
    expect(parsed.hint).toBe(parsed.message)
    expect(parsed.details.diagnostic).toBe("device_offline")
    expect(parsed.details.deviceName).toBe("midgar")

    // 2. The notifier was invoked asynchronously — wait a tick for the
    //    fire-and-forget promise to resolve.
    await new Promise((r) => setImmediate(r))
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe("remote.device_offline")
    expect(sent[0].channelId).toBe("ch_1")
    expect(sent[0].message).toContain("midgar is offline")
    expect(sent[0].metadata?.deviceId).toBe("dev_midgar")
  })

  it("skips the notifier when no channelId is present (internal call)", async () => {
    const dispatch = mock(async () => offlinePayload())
    const sent: RemoteChannelNotification[] = []
    const notifier = new RemoteOfflineNotifier({
      notify: (n) => {
        sent.push(n)
      },
    })
    const ctx = makeCtx({
      remoteGateway: { dispatch } as unknown as RemoteDeviceGateway,
      remoteOfflineNotifier: notifier,
    })
    const managed = makeManagedRemote()

    const result = await executeToolViaRemote(ctx, managed, "midgar_bash", {
      command: "ls",
    }) // no context at all

    expect(result.isError).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(sent).toHaveLength(0)
  })

  it("skips the notifier when the gateway is not configured (legacy fallback)", async () => {
    const sent: RemoteChannelNotification[] = []
    const notifier = new RemoteOfflineNotifier({
      notify: (n) => {
        sent.push(n)
      },
    })
    const ctx = makeCtx({
      remoteGateway: undefined,
      remoteOfflineNotifier: notifier,
    })
    const managed = makeManagedRemote()

    const result = await executeToolViaRemote(
      ctx,
      managed,
      "midgar_bash",
      {
        command: "ls",
      },
      {
        channelId: "ch_1",
      },
    )

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.error).toBe("MACHINE_UNREACHABLE")
    // No diagnostic in details → no notification (nothing to classify).
    await new Promise((r) => setImmediate(r))
    expect(sent).toHaveLength(0)
  })

  it("session_dead diagnostic does NOT notify the channel (transient, no spam)", async () => {
    const sessionDeadPayload: RemoteToolResultPayload = {
      success: false,
      duration: 0,
      error: {
        code: "MACHINE_UNREACHABLE",
        message:
          "⚠ midgar just disconnected (reconnect in progress). The agent will retry automatically — if it does not come back, run `teros-remote status` on the machine.",
        hint: "⚠ midgar just disconnected (reconnect in progress). The agent will retry automatically — if it does not come back, run `teros-remote status` on the machine.",
        details: {
          diagnostic: "session_dead",
          appId: "app_remote_1",
          deviceId: "dev_midgar",
          deviceName: "midgar",
          lastSeenAt: new Date().toISOString(),
          lastSeenHuman: "just now",
        },
      },
    }
    const dispatch = mock(async () => sessionDeadPayload)
    const sent: RemoteChannelNotification[] = []
    const notifier = new RemoteOfflineNotifier({
      notify: (n) => {
        sent.push(n)
      },
    })
    const ctx = makeCtx({
      remoteGateway: { dispatch } as unknown as RemoteDeviceGateway,
      remoteOfflineNotifier: notifier,
    })
    const managed = makeManagedRemote()

    const result = await executeToolViaRemote(
      ctx,
      managed,
      "midgar_bash",
      {
        command: "ls",
      },
      {
        channelId: "ch_1",
      },
    )

    expect(result.isError).toBe(true)
    await new Promise((r) => setImmediate(r))
    // session_dead is transient — the notifier deliberately skips it.
    expect(sent).toHaveLength(0)
  })
})
