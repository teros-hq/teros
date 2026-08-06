/**
 * Unit tests for inline user forms — the request-user-input built-in tool
 *:
 *
 *   - FormSpecSchema / validateFormValues — LLM-composed specs are validated,
 *     submitted values are validated server-side against the persisted spec.
 *   - PendingFormsRegistry — pending CRUD, one-per-channel rule, idempotency TTL.
 *   - FormManager — ask/submit/dismiss lifecycle, validation failures keep the
 *     form pending, restored forms finalize without a live turn.
 *   - McaToolExecutor.executeFormRequest — flag gate, spec validation, headless
 *     bypass, post-wait abort fail-fast, resolution → tool-result mapping.
 *
 * Executor harness mirrors tool-execution-proxy.test.ts: a real McaToolExecutor
 * over mocked McaManager + McaService.
 */

import { describe, expect, it, mock } from "bun:test"
import { FORM_TOOL_NAME, FormSpecSchema, validateFormValues, type FormSpec } from "@teros/shared"
import { createFormManager } from "../../src/handlers/message/form-manager"
import { PendingFormsRegistry } from "../../src/handlers/message/pending-forms-registry"
import type { McaManager } from "../../src/services/mca-manager"
import type { McaService } from "../../src/services/mca-service"
import { McaToolExecutor, type UserFormResolution } from "../../src/services/mca-tool-executor"

const AGENT = "agent_test"
const CHANNEL = "ch_test"

const VALID_SPEC = {
  title: "Booking details",
  fields: [
    { id: "name", type: "text", label: "Full name", required: true },
    { id: "guests", type: "number", label: "Guests", min: 1, max: 10 },
    {
      id: "meal",
      type: "select",
      label: "Meal",
      options: [
        { value: "veg", label: "Vegetarian" },
        { value: "meat", label: "Meat" },
      ],
    },
    { id: "date", type: "date", label: "Date", min: "2026-07-05" },
    { id: "confirmed", type: "checkbox", label: "Confirm" },
  ],
} satisfies Record<string, unknown>

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

describe("FormSpecSchema", () => {
  it("accepts a valid spec", () => {
    expect(FormSpecSchema.safeParse(VALID_SPEC).success).toBe(true)
  })

  it("rejects duplicate field ids", () => {
    const spec = {
      fields: [
        { id: "a", type: "text", label: "A" },
        { id: "a", type: "number", label: "A again" },
      ],
    }
    const result = FormSpecSchema.safeParse(spec)
    expect(result.success).toBe(false)
  })

  it("rejects more than MAX_FORM_FIELDS fields", () => {
    const fields = Array.from({ length: 13 }, (_, i) => ({
      id: `f${i}`,
      type: "text",
      label: `F${i}`,
    }))
    expect(FormSpecSchema.safeParse({ fields }).success).toBe(false)
  })

  it("rejects select without options and empty forms", () => {
    expect(
      FormSpecSchema.safeParse({ fields: [{ id: "s", type: "select", label: "S" }] }).success,
    ).toBe(false)
    expect(FormSpecSchema.safeParse({ fields: [] }).success).toBe(false)
  })

  it("rejects malicious field ids", () => {
    expect(
      FormSpecSchema.safeParse({ fields: [{ id: "$where", type: "text", label: "X" }] }).success,
    ).toBe(false)
  })
})

describe("validateFormValues", () => {
  const spec = FormSpecSchema.parse(VALID_SPEC)

  it("accepts a valid submission and strips unknown keys", () => {
    const result = validateFormValues(spec, {
      name: "Ada",
      guests: 4,
      meal: "veg",
      date: "2026-08-01",
      confirmed: true,
      smuggled: "nope",
    })
    expect(result.ok).toBe(true)
    expect(result.values).toEqual({
      name: "Ada",
      guests: 4,
      meal: "veg",
      date: "2026-08-01",
      confirmed: true,
    })
  })

  it("flags missing required fields, optional ones may be absent", () => {
    const result = validateFormValues(spec, { guests: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(["'name' is required"])
  })

  it("enforces types, option membership and bounds", () => {
    const result = validateFormValues(spec, {
      name: "Ada",
      guests: 99, // > max 10
      meal: "fish", // not an option
      date: "2026-01-01", // < min
      confirmed: "yes", // not a boolean
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(4)
  })

  it("rejects non-record payloads", () => {
    expect(validateFormValues(spec, "nope").ok).toBe(false)
    expect(validateFormValues(spec, { name: { $gt: "" } }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("PendingFormsRegistry", () => {
  const spec = FormSpecSchema.parse(VALID_SPEC)
  const pendingForm = (channelId: string) => ({
    resolve: () => {},
    reject: () => {},
    spec,
    channelId,
  })

  it("tracks pendings per channel (one-per-channel rule input)", () => {
    const registry = new PendingFormsRegistry()
    registry.register("form_1", pendingForm("ch_A"))
    expect(registry.hasPendingInChannel("ch_A")).toBe(true)
    expect(registry.hasPendingInChannel("ch_B")).toBe(false)
    registry.delete("form_1")
    expect(registry.hasPendingInChannel("ch_A")).toBe(false)
  })

  it("records resolutions for idempotency and prunes expired ones", () => {
    const registry = new PendingFormsRegistry({ resolvedTtlMs: 0, resolvedPruneThreshold: 1 })
    registry.recordResolved("form_1", { kind: "dismissed" })
    expect(registry.getResolved("form_1")).toBeDefined()
    expect(registry.pruneResolved(Date.now() + 1)).toBe(1)
    expect(registry.getResolved("form_1")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FormManager
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

const SPEC = FormSpecSchema.parse({
  fields: [{ id: "name", type: "text", label: "Name", required: true }],
})

const toolCallContext = (toolCallId?: string) =>
  toolCallId ? { messageId: "msg_1", toolCallId, toolName: FORM_TOOL_NAME } : null

describe("FormManager", () => {
  it("submit flow: validates values, flips status via onFormSubmitted, resolves the tool promise", async () => {
    const { manager } = makeManager()
    let pendingRequestId: string | undefined
    const statusFlips: string[] = []

    const ask = manager.createAskFormCallback(CHANNEL, "user_1", toolCallContext, {
      onPendingForm: async (formRequestId) => {
        pendingRequestId = formRequestId
        statusFlips.push("pending_user_input")
      },
      onFormSubmitted: async () => {
        statusFlips.push("running")
      },
    })

    const resolutionPromise = ask(SPEC, "tc_1")
    await Bun.sleep(0) // let onPendingForm run
    expect(pendingRequestId).toStartWith("form_")

    const response = await manager.handleResponse(pendingRequestId!, {
      values: { name: "Ada" },
      notes: "  ",
    })
    expect(response).toEqual({ channelId: CHANNEL })

    const resolution = await resolutionPromise
    expect(resolution).toEqual({ kind: "submitted", values: { name: "Ada" }, notes: undefined })
    expect(statusFlips).toEqual(["pending_user_input", "running"])
    expect(manager.getPendingCount()).toBe(0)
  })

  it("invalid submission keeps the form pending and returns errors", async () => {
    const { manager } = makeManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskFormCallback(CHANNEL, "user_1", toolCallContext, {
      onPendingForm: async (formRequestId) => {
        pendingRequestId = formRequestId
      },
    })

    const resolutionPromise = ask(SPEC, "tc_1")
    await Bun.sleep(0)

    const bad = await manager.handleResponse(pendingRequestId!, { values: {} })
    expect(bad?.errors).toEqual(["'name' is required"])
    expect(manager.getPendingCount()).toBe(1) // still waiting

    await manager.handleResponse(pendingRequestId!, { dismissed: true })
    expect(await resolutionPromise).toEqual({ kind: "dismissed" })
  })

  it("duplicate responses are idempotent no-ops; unknown ids return null", async () => {
    const { manager } = makeManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskFormCallback(CHANNEL, "user_1", toolCallContext, {
      onPendingForm: async (formRequestId) => {
        pendingRequestId = formRequestId
      },
    })
    const resolutionPromise = ask(SPEC, "tc_1")
    await Bun.sleep(0)

    await manager.handleResponse(pendingRequestId!, { dismissed: true })
    await resolutionPromise
    const dup = await manager.handleResponse(pendingRequestId!, { values: { name: "X" } })
    expect(dup?.idempotent).toBe(true)

    expect(await manager.handleResponse("form_unknown", { dismissed: true })).toBeNull()
  })

  it("resolves unavailable when the form cannot be anchored to a message", async () => {
    const { manager } = makeManager()
    const ask = manager.createAskFormCallback(CHANNEL, "user_1", () => null, {})
    const resolution = await ask(SPEC, "tc_untracked")
    expect(resolution.kind).toBe("unavailable")
  })

  it("enforces one live form per channel", async () => {
    const { manager } = makeManager()
    const ask = manager.createAskFormCallback(CHANNEL, "user_1", toolCallContext, {
      onPendingForm: async () => {},
    })
    const first = ask(SPEC, "tc_1")
    await Bun.sleep(0)
    const second = await ask(SPEC, "tc_2")
    expect(second.kind).toBe("unavailable")
    // First is still pending and answerable
    expect(manager.getPendingCount()).toBe(1)
    void first
  })

  it("clearAll resolves live forms as unavailable and keeps idempotency records", async () => {
    const { manager } = makeManager()
    let pendingRequestId: string | undefined
    const ask = manager.createAskFormCallback(CHANNEL, "user_1", toolCallContext, {
      onPendingForm: async (formRequestId) => {
        pendingRequestId = formRequestId
      },
    })
    const resolutionPromise = ask(SPEC, "tc_1")
    await Bun.sleep(0)

    manager.clearAll()
    expect((await resolutionPromise).kind).toBe("unavailable")
    const dup = await manager.handleResponse(pendingRequestId!, { dismissed: true })
    expect(dup?.idempotent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Executor — executeFormRequest
// ---------------------------------------------------------------------------

const APP = "app_x"
const APP_TOOLS = [
  {
    name: "x_do-thing",
    description: "Do a thing",
    input_schema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
]

function makeExecutorMocks() {
  const app = {
    appId: APP,
    mcaId: "mca.x",
    name: "x",
    permissions: { tools: { "do-thing": "allow" }, defaultPermission: "ask" },
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
  } as unknown as McaService
  return { mcaManager, mcaService }
}

async function buildExecutor(opts: { formsEnabled?: boolean; headless?: boolean } = {}) {
  const { mcaManager, mcaService } = makeExecutorMocks()
  const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
    workspaceId: "work_test",
  })
  await exec.initialize()
  exec.setUserContext("user_1", "work_test", "human", undefined, opts.headless ?? false)
  exec.setFormsEnabled(opts.formsEnabled ?? true)
  return exec
}

describe("McaToolExecutor — request-user-input", () => {
  it("injects the tool ahead of app tools when the flag is on, not when off", async () => {
    const on = await buildExecutor({ formsEnabled: true })
    expect(on.getTools()[0]?.name).toBe(FORM_TOOL_NAME)

    const off = await buildExecutor({ formsEnabled: false })
    expect(off.getTools().some((t) => t.name === FORM_TOOL_NAME)).toBe(false)
  })

  it("flag off: the name falls through to the standard does-not-exist rejection", async () => {
    const exec = await buildExecutor({ formsEnabled: false })
    const result = await exec.executeTool(FORM_TOOL_NAME, VALID_SPEC, { toolCallId: "tc_1" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("does not exist")
  })

  it("rejects an invalid spec with an actionable error (never renders)", async () => {
    const exec = await buildExecutor()
    const asked = mock(async (): Promise<UserFormResolution> => ({ kind: "dismissed" }))
    exec.setAskUserFormCallback(asked)
    const result = await exec.executeTool(FORM_TOOL_NAME, { fields: [] }, { toolCallId: "tc_1" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("invalid form spec")
    expect(asked).not.toHaveBeenCalled()
  })

  it("headless channels get the conversational bypass without rendering", async () => {
    const exec = await buildExecutor({ headless: true })
    const asked = mock(async (): Promise<UserFormResolution> => ({ kind: "dismissed" }))
    exec.setAskUserFormCallback(asked)
    const result = await exec.executeTool(FORM_TOOL_NAME, VALID_SPEC, { toolCallId: "tc_1" })
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.available).toBe(false)
    expect(parsed.fields).toHaveLength(5)
    expect(asked).not.toHaveBeenCalled()
  })

  it("submitted resolution becomes the tool result", async () => {
    const exec = await buildExecutor()
    exec.setAskUserFormCallback(async () => ({
      kind: "submitted",
      values: { name: "Ada" },
      notes: "be quick",
    }))
    const result = await exec.executeTool(FORM_TOOL_NAME, VALID_SPEC, { toolCallId: "tc_1" })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output)).toEqual({
      submitted: true,
      values: { name: "Ada" },
      notes: "be quick",
    })
  })

  it("dismissal tells the agent to continue conversationally (not an error)", async () => {
    const exec = await buildExecutor()
    exec.setAskUserFormCallback(async () => ({ kind: "dismissed" }))
    const result = await exec.executeTool(FORM_TOOL_NAME, VALID_SPEC, { toolCallId: "tc_1" })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output).dismissed).toBe(true)
  })

  it("fails fast when the form resolves after the turn was aborted (82eee84e)", async () => {
    const exec = await buildExecutor()
    const controller = new AbortController()
    exec.setAskUserFormCallback(async () => {
      controller.abort()
      return { kind: "submitted", values: { name: "Ada" } }
    })
    const result = await exec.executeTool(FORM_TOOL_NAME, VALID_SPEC, {
      toolCallId: "tc_1",
      signal: controller.signal,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("interrupted")
  })
})
