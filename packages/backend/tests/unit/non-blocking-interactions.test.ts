/**
 * Unit tests for v2 non-blocking user interactions
 * (docs/specs/20261024_non-blocking-user-interactions.md) — the
 * `interactions.non-blocking` flag path:
 *
 *   - Forms: the ask callback returns the immediate { kind: 'displayed' }
 *     marker (no Promise block), the channel enters awaiting_user
 *     { kind: 'form' }, submit finalizes into the channel (tool output +
 *     onFormResolved wake hook) and clears awaiting_user, and a free user
 *     message auto-resolves the pending form as answered_in_chat with the
 *     formRequestId for respondsTo.
 *   - Permissions: REVERTED to v1 blocking (Pablo decision, 2026-10-25,
 *     after E2E) — the ask callback parks the turn on a Promise and resolves
 *     'granted'/'denied' when the user answers; the tool executes in the same
 *     turn on grant. No synthetic messages, no phases, no wake. Forms/auth
 *     remain v2. The section below pins the v1 semantics so they don't
 *     silently regress.
 *   - AwaitingAuthRegistry: register/consume/clearChannel/hasChannel.
 *
 * Harness mirrors inline-user-forms.test.ts: createFormManager with
 * broadcast/contentWrites collectors; a real McaToolExecutor over mocked
 * McaManager + McaService.
 */

import { describe, expect, it, mock } from "bun:test"
import { FORM_TOOL_NAME, FormSpecSchema, type FormSpec } from "@teros/shared"
import { createFormManager } from "../../src/handlers/message/form-manager"
import { createPermissionManager } from "../../src/handlers/message/permission-manager"
import { AwaitingAuthRegistry } from "../../src/handlers/message/awaiting-auth-registry"
import type { McaManager } from "../../src/services/mca-manager"
import type { McaService } from "../../src/services/mca-service"
import { McaToolExecutor, type UserFormResolution } from "../../src/services/mca-tool-executor"

const AGENT = "agent_test"
const CHANNEL = "ch_test"

const SPEC = FormSpecSchema.parse({
  title: "Booking details",
  fields: [
    { id: "name", type: "text", label: "Full name", required: true },
    { id: "guests", type: "number", label: "Guests", min: 1, max: 10 },
  ],
}) as FormSpec

const toolCallContext = (toolCallId?: string) =>
  toolCallId ? { messageId: "msg_1", toolCallId, toolName: FORM_TOOL_NAME } : null

// ---------------------------------------------------------------------------
// Forms — non-blocking ask / submit / answered_in_chat
// ---------------------------------------------------------------------------

function makeManager() {
  const broadcasts: any[] = []
  const contentWrites: Array<{ messageId: string; fields: Record<string, unknown> }> = []
  const manager = createFormManager({
    broadcastToChannel: (_channelId, message) => broadcasts.push(message),
    updateMessageContentFields: async (messageId, fields) => {
      contentWrites.push({ messageId, fields })
    },
  })
  return { manager, broadcasts, contentWrites }
}

describe("FormManager — non-blocking (v2)", () => {
  it("ask returns the immediate displayed marker and enters awaiting_user", async () => {
    const { manager, broadcasts } = makeManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskFormCallback(
      CHANNEL,
      "user_1",
      toolCallContext,
      {
        onPendingForm: async (formRequestId) => {
          pendingRequestId = formRequestId
        },
      },
    )

    const marker = await ask(SPEC, "tc_1")
    expect(pendingRequestId).toStartWith("form_")
    // Immediate marker — the turn ends here, no Promise block.
    expect(marker).toEqual({ kind: "displayed", formRequestId: pendingRequestId })

    // The channel entered awaiting_user { kind: 'form', pointer }.
    const enter = broadcasts.find((b) => b.type === "channel_status" && b.awaitingUser)
    expect(enter?.awaitingUser).toEqual({ kind: "form", pointer: pendingRequestId })
    expect(manager.getPendingCount()).toBe(1)
  })

  it("submit finalizes into the channel and fires onFormResolved (wake)", async () => {
    const { manager, broadcasts, contentWrites } = makeManager()
    const resolved: any[] = []
    const managerWithHook = createFormManager({
      broadcastToChannel: (_c, message) => broadcasts.push(message),
      updateMessageContentFields: async (messageId, fields) => {
        contentWrites.push({ messageId, fields })
      },
      onFormResolved: async (info) => {
        resolved.push(info)
      },
    })

    let pendingRequestId: string | undefined
    const ask = managerWithHook.createAskFormCallback(
      CHANNEL,
      "user_1",
      toolCallContext,
      {
        onPendingForm: async (formRequestId) => {
          pendingRequestId = formRequestId
        },
      },
      true,
    )
    await ask(SPEC, "tc_1")

    const response = await managerWithHook.handleResponse(pendingRequestId!, {
      values: { name: "Ada", guests: 2 },
      notes: "late arrival",
    })
    expect(response).toEqual({ channelId: CHANNEL })

    // handleResponse fire-and-forgets the finalize+wake chain (the WS ack must
    // not wait for the LLM wake) — flush the microtask queue before asserting
    // its effects.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // The wake hook fired with the submitted resolution.
    expect(resolved).toHaveLength(1)
    expect(resolved[0].channelId).toBe(CHANNEL)
    expect(resolved[0].formRequestId).toBe(pendingRequestId)
    expect(resolved[0].resolution.kind).toBe("submitted")

    // The tool_execution got the output persisted (content write).
    const outputWrite = contentWrites.find((w) => w.fields.output !== undefined)
    expect(outputWrite).toBeDefined()
    const output = JSON.parse(String(outputWrite!.fields.output))
    expect(output.submitted).toBe(true)
    expect(output.values).toEqual({ name: "Ada", guests: 2 })

    // Nothing pending anymore.
    expect(managerWithHook.getPendingCount()).toBe(0)
  })

  it("a free user message auto-resolves the pending form as answered_in_chat and returns the pointer", async () => {
    const { manager } = makeManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskFormCallback(
      CHANNEL,
      "user_1",
      toolCallContext,
      {
        onPendingForm: async (formRequestId) => {
          pendingRequestId = formRequestId
        },
      },
      true,
    )
    await ask(SPEC, "tc_1")

    // The user typed a normal chat message instead of using the form.
    const pointer = await manager.resolvePendingInChannelAsAnsweredInChat(CHANNEL)
    expect(pointer).toBe(pendingRequestId)

    // The pending is gone and a later widget submit is an idempotent no-op.
    expect(manager.getPendingCount()).toBe(0)
    const dup = await manager.handleResponse(pendingRequestId!, {
      values: { name: "Ada", guests: 2 },
    })
    expect(dup?.idempotent).toBe(true)
  })

})

// ---------------------------------------------------------------------------
// Permissions — non-blocking ask / grant / deny
// ---------------------------------------------------------------------------

function makePermissionManager() {
  const broadcasts: any[] = []
  const userBroadcasts: any[] = []
  const contentWrites: Array<{ messageId: string; fields: Record<string, unknown> }> = []
  const restoredExecutions: any[] = []
  const grantedFlips: string[] = []
  const wakes: any[] = []
  const manager = createPermissionManager({
    broadcastToChannel: (_channelId, event) => broadcasts.push(event),
    broadcastToUser: (_userId, event) => userBroadcasts.push(event),
    // PERMB-REQ-3: the batch wake hook — collect calls so tests can assert
    // the agent is woken ONCE in a new turn, after the batch is decided.
    onBatchResolved: async (args) => {
      wakes.push(args)
    },
  })
  return {
    manager,
    broadcasts,
    userBroadcasts,
    restoredExecutions,
    grantedFlips,
    wakes,
  }
}

describe("PermissionManager — v4 permission cut (2026-10-27)", () => {
  it("ask returns the immediate 'permission_requested' marker — no parked Promise, widget broadcast intact", async () => {
    const { manager, broadcasts } = makePermissionManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskPermissionCallback(
      CHANNEL,
      "user_1",
      (toolCallId) => (toolCallId ? { messageId: "msg_1", toolCallId, toolName: "x_do-thing" } : null),
      {
        onPendingPermission: async (requestId) => {
          pendingRequestId = requestId
        },
      },
      "work_test",
    )
    // v4: the ask settles IMMEDIATELY with the marker — no parked promise. The
    // executor turns this into endsTurn → the session closes with the REAL
    // duration; the user's thinking time falls between sessions and never
    // counts as agent-hours (the durationMs=30:00 bug). The requestId travels
    // IN the marker so the executor can serialize it into the awaiting-user
    // output the frontend renders the ControlsBar from.
    const result = await ask("x_do-thing", "app_x", { a: 1 }, false, "tc_1")
    expect(result).toEqual({ kind: "requested", requestId: pendingRequestId })
    expect(pendingRequestId).toStartWith("perm_")

    // The pending is registered in the registry (the widget renders from this
    // state, decoupled from the turn lifecycle).
    expect(manager.getPendingCount()).toBe(1)

    // The permission request itself was broadcast for the inline widget —
    // UX identical to v1.
    const request = broadcasts.find((b) => b.type === "tool_permission_request")
    expect(request?.requestId).toBe(pendingRequestId)
    expect(request?.messageId).toBe("msg_1")
    expect(request?.toolCallId).toBe("tc_1")
  })

  it("grant resolves server-side: tool executes with the persisted input, ONE batch wake", async () => {
    const { manager, restoredExecutions, wakes } = makePermissionManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskPermissionCallback(
      CHANNEL,
      "user_1",
      (toolCallId) => (toolCallId ? { messageId: "msg_1", toolCallId, toolName: "x_do-thing" } : null),
      {
        onPendingPermission: async (requestId) => {
          pendingRequestId = requestId
        },
      },
      "work_test",
    )
    const result = await ask("x_do-thing", "app_x", { a: 1 }, false, "tc_1")
    expect(result).toEqual({ kind: "requested", requestId: pendingRequestId })

    // The WS ack returns immediately (fire-and-forget) — handleResponse
    // resolves before the tool/wake chain completes.
    const outcome = await manager.handleResponse(
      pendingRequestId!,
      true,
      async (args) => {
        restoredExecutions.push(args)
        return { output: '{"ok":true}', isError: false }
      },
    )
    expect(outcome.channelId).toBe(CHANNEL)
    expect(outcome.toolName).toBe("x_do-thing")

    // The fire-and-forget chain runs the tool SERVER-SIDE with the persisted
    // original input (the restored path — executeRestoredTool in the handler).
    await new Promise((r) => setTimeout(r, 25))
    expect(restoredExecutions).toHaveLength(1)
    expect(restoredExecutions[0]).toMatchObject({
      channelId: CHANNEL,
      toolName: "x_do-thing",
      input: { a: 1 },
    })

    // PERMB-REQ-3: a batch of one wakes once, after its single decision.
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([{ toolName: "x_do-thing", outcome: "granted" }])

    // The pending is gone and a duplicate grant is an idempotent no-op.
    expect(manager.getPendingCount()).toBe(0)
  })

  it("deny resolves server-side: fail-closed, nothing executes, the agent wakes with the reason", async () => {
    const { manager, restoredExecutions, wakes, broadcasts } = makePermissionManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskPermissionCallback(
      CHANNEL,
      "user_1",
      (toolCallId) => (toolCallId ? { messageId: "msg_1", toolCallId, toolName: "x_do-thing" } : null),
      {
        onPendingPermission: async (requestId) => {
          pendingRequestId = requestId
        },
      },
      "work_test",
    )
    const result = await ask("x_do-thing", "app_x", { a: 1 }, false, "tc_1")
    expect(result).toEqual({ kind: "requested", requestId: pendingRequestId })
    const outcome = await manager.handleResponse(
      pendingRequestId!,
      false,
      async (args) => {
        restoredExecutions.push(args)
        return { output: "unreachable", isError: true }
      },
    )
    expect(outcome.channelId).toBe(CHANNEL)

    // Fail-closed intact: nothing executed server-side on a deny.
    await new Promise((r) => setTimeout(r, 25))
    expect(restoredExecutions).toHaveLength(0)

    // The agent WAKES in a new turn with the denial — it must learn the user
    // declined instead of waiting forever for a turn that never comes.
    expect(wakes).toHaveLength(1)
    expect(wakes[0].outcomes).toEqual([{ toolName: "x_do-thing", outcome: "denied" }])

    // CERO mensajes en nombre del usuario — no synthetic user-role message is
    // ever persisted or broadcast (the 2026-10-25 revert lesson: user-role
    // 'event' messages rendered as "Unsupported message type event").
    const synthetic = broadcasts.find(
      (b) =>
        b.type === "message" &&
        b.message?.role === "user",
    )
    expect(synthetic).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Executor markers — form_displayed (v2, forms) / permission ask (v1 blocking)
// ---------------------------------------------------------------------------

const APP = "app_x"
const APP_TOOLS = [
  {
    name: "x_do-thing",
    description: "Do a thing",
    input_schema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: false },
  },
]

function makeExecutorMocks() {
  const app = {
    appId: APP,
    mcaId: "mca.x",
    name: "x",
    permissions: { tools: { "do-thing": "ask" }, defaultPermission: "ask" },
  }
  const mcaManager = {
    registerApp: mock(async () => undefined),
    getToolsForApp: mock(async () => ({ tools: APP_TOOLS, status: "standby" as const })),
    executeTool: mock(async () => ({ output: '{"ok":true}', isError: false })),
    getMcaIdForTool: mock(() => "mca.x"),
  } as unknown as McaManager
  const mcaService = {
    getAgentApps: mock(async () => ({
      agentId: AGENT,
      apps: [{ app: { ...app, mca: { mcaId: "mca.x" } }, access: {} }],
    })),
    getApp: mock(async () => app),
    hasAccess: mock(async () => true),
    // MUW-REQ-12: no channel document behind CHANNEL in these suites — a null
    // viewer keeps the executor's own user context (set via setUserContext).
    getChannelViewer: mock(async () => null),
  } as unknown as McaService
  return { mcaManager, mcaService }
}

async function buildExecutor() {
  const { mcaManager, mcaService } = makeExecutorMocks()
  const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
    workspaceId: "work_test",
  })
  await exec.initialize()
  exec.setUserContext("user_1", "work_test", "human", undefined, false)
  exec.setFormsEnabled(true)
  return exec
}

describe("McaToolExecutor — interaction markers", () => {
  it("displayed marker becomes { status: 'form_displayed' } isError: false + endsTurn: true", async () => {
    const exec = await buildExecutor()
    exec.setAskUserFormCallback(
      mock(async (): Promise<UserFormResolution | { kind: "displayed"; formRequestId: string }> => ({
        kind: "displayed",
        formRequestId: "form_123",
      })) as never,
    )
    const result = await exec.executeTool(FORM_TOOL_NAME, SPEC, { toolCallId: "tc_1" })
    expect(result.isError).toBe(false)
    // endsTurn: the TurnDriver cuts the turn deterministically — no second
    // LLM call hoping the model obeys the textual instruction (2026-10-25).
    expect(result.endsTurn).toBe(true)
    // PERMB-REQ-1: a form marker skips the rest of the step.
    expect(result.awaiting).toBe("form")
    const parsed = JSON.parse(result.output)
    expect(parsed.status).toBe("form_displayed")
    expect(parsed.formRequestId).toBe("form_123")
  })

  it("permission ask is v4: the marker ends the turn (endsTurn), granted/denied defense paths unchanged", async () => {
    // The marker — the ask registered the pending permission; the turn ENDS
    // (endsTurn) with real duration. NOT a deny: isError false. The
    // permissionRequestId travels in the marker output so the frontend can
    // render the ControlsBar from it (completeToolMessage drops the content
    // fields on completion).
    const exec = await buildExecutor()
    exec.setAskPermissionCallback(
      mock(async () => ({ kind: "requested" as const, requestId: "perm_123" })) as never,
    )
    const marker = await exec.executeTool("x_do-thing", { a: 1 }, { toolCallId: "tc_1" })
    expect(marker.isError).toBe(false)
    expect(marker.endsTurn).toBe(true)
    // PERMB-REQ-1: a permission marker does not skip the rest of the step.
    expect(marker.awaiting).toBe("permission")
    const parsed = JSON.parse(marker.output)
    expect(parsed.status).toBe("permission_requested")
    expect(parsed.permissionRequestId).toBe("perm_123")
    expect(parsed.tool).toBe("x_do-thing")
    expect(parsed.appId).toBe("app_x")
    expect(parsed.instruction).toContain("End your turn now")

    // Granted — the tool runs with the original input, no endsTurn marker
    // (defense path: the ask resolved before registering, e.g. auto-deny).
    const exec1 = await buildExecutor()
    exec1.setAskPermissionCallback(
      mock(async () => "granted" as const) as never,
    )
    const granted = await exec1.executeTool("x_do-thing", { a: 1 }, { toolCallId: "tc_1" })
    expect(granted.isError).toBe(false)
    expect(granted.endsTurn).toBeUndefined()
    expect(granted.output).toBe('{"ok":true}')

    // Denied — permissionDenied error in the same turn, no endsTurn marker
    // (defense path).
    const exec2 = await buildExecutor()
    exec2.setAskPermissionCallback(
      mock(async () => "denied" as const) as never,
    )
    const denied = await exec2.executeTool("x_do-thing", { a: 1 }, { toolCallId: "tc_1" })
    expect(denied.isError).toBe(true)
    expect(denied.permissionDenied).toBe(true)
    expect(denied.endsTurn).toBeUndefined()
    expect(denied.output).toContain("Permission denied: User declined")
  })
})

// ---------------------------------------------------------------------------
// AwaitingAuthRegistry
// ---------------------------------------------------------------------------

describe("AwaitingAuthRegistry", () => {
  it("register / consume / hasChannel / clearChannel lifecycle", () => {
    const registry = new AwaitingAuthRegistry()
    registry.register("user_1", "app_x", CHANNEL)
    expect(registry.hasChannel(CHANNEL)).toBe(true)
    expect(registry.size()).toBe(1)

    const entry = registry.consume("user_1", "app_x")
    expect(entry?.channelId).toBe(CHANNEL)
    expect(entry?.appId).toBe("app_x")
    expect(registry.hasChannel(CHANNEL)).toBe(false)

    // Consuming again is a no-op.
    expect(registry.consume("user_1", "app_x")).toBeNull()

    // clearChannel drops every entry pointing at the channel.
    registry.register("user_1", "app_a", CHANNEL)
    registry.register("user_1", "app_b", CHANNEL)
    registry.register("user_1", "app_c", "ch_other")
    registry.clearChannel(CHANNEL)
    expect(registry.hasChannel(CHANNEL)).toBe(false)
    expect(registry.size()).toBe(1) // ch_other survives
  })
})
