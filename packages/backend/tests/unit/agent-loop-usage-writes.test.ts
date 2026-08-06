/**
 * Contract — escritura de billing del turno: handleMessageComplete (TER-473).
 *
 * El bloque de usage del agent-loop alimenta TRES writes: updateUsage
 * (presupuesto del canal), trackUsage (llm_usage para facturación) y
 * recordDelta (agent_usage_sessions). Un campo mal etiquetado = facturación
 * incorrecta. Ctx fake con la superficie exacta de AgentLoopContext; asserts
 * de payload EXACTO (toEqual).
 */

import { describe, expect, it, mock } from "bun:test"
import { handleMessageComplete } from "../../src/handlers/message/agent-loop"
import { classifyError } from "../../src/services/agent-usage-session-service"

const CHANNEL_ID = "ch_0123456789abcdef"
const AGENT_ID = "agent_aaaa111122223333"
const USER_ID = "user_aaaaaaaaaaaaaaaa"
const WORKSPACE_ID = "work_aaaaaaaaaaaaaaaa"

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: ctx fake parcial
  ctx: any
  updateUsage: ReturnType<typeof mock>
  trackUsage: ReturnType<typeof mock>
  recordDelta: ReturnType<typeof mock>
  broadcastToChannel: ReturnType<typeof mock>
}

function makeHarness(): Harness {
  const updateUsage = mock(async () => ({}))
  const trackUsage = mock(async () => ({}))
  const recordDelta = mock(() => {})
  const broadcastToChannel = mock(() => {})

  const ctx = {
    channelManager: {
      getChannel: mock(async () => ({
        channelId: CHANNEL_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
      })),
    },
    db: {
      collection: mock(() => ({
        findOne: mock(async () => ({ agentId: AGENT_ID, workspaceId: WORKSPACE_ID })),
      })),
    },
    usageService: {
      updateUsage,
      calculateBudget: mock(async () => null), // sin budget → sin broadcast
    },
    usageTrackingService: { trackUsage },
    agentUsageSessionService: { recordDelta },
    broadcastToChannel,
    broadcastChannelListStatus: mock(() => {}),
    broadcastChannelStatus: mock(() => {}),
    maybeAutonameChannel: mock(async () => {}),
  }
  return { ctx, updateUsage, trackUsage, recordDelta, broadcastToChannel }
}

function makeStreamPieces() {
  return {
    streamState: {
      savedMessages: [{ type: "text", messageId: "msg_final0000000001" }],
      currentTextContent: "respuesta final del agente",
      // biome-ignore lint/suspicious/noExplicitAny: solo los campos usados
    } as any,
    streamHelpers: {
      completeTextMessage: mock(async () => {}),
      // biome-ignore lint/suspicious/noExplicitAny: solo los campos usados
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: solo los campos usados
    typingManager: { stop: mock(() => {}) } as any,
  }
}

const AGENT_CONFIG = {
  coreId: "core_x",
  llm: {
    provider: "anthropic",
    modelId: "model_sonnet",
    modelString: "claude-3-5-sonnet-20241022",
  },
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, cacheWriteTokens: 20 },
    stopReason: "end_turn",
    ...overrides,
  }
}

async function run(harness: Harness, data: unknown) {
  const { streamState, streamHelpers, typingManager } = makeStreamPieces()
  await handleMessageComplete(
    harness.ctx,
    CHANNEL_ID,
    AGENT_ID,
    AGENT_CONFIG,
    data,
    streamState,
    streamHelpers,
    typingManager,
  )
}

// ===========================================================================
// updateUsage — presupuesto del canal
// ===========================================================================

describe("handleMessageComplete → updateUsage", () => {
  it("escribe los tokens EXACTOS con el contexto denormalizado del canal", async () => {
    const h = makeHarness()
    await run(h, baseData())

    expect(h.updateUsage).toHaveBeenCalledTimes(1)
    const [channelId, modelId, usage, breakdown, context] = h.updateUsage.mock.calls[0]
    expect(channelId).toBe(CHANNEL_ID)
    expect(modelId).toBe("model_sonnet")
    expect(usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
    })
    expect(breakdown).toBeUndefined()
    expect(context).toEqual({ userId: USER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID })
  })

  it("usage ausente o llm config ausente → NO escribe nada", async () => {
    const h = makeHarness()
    await run(h, { stopReason: "end_turn" }) // sin usage
    expect(h.updateUsage).not.toHaveBeenCalled()
    expect(h.trackUsage).not.toHaveBeenCalled()
    expect(h.recordDelta).not.toHaveBeenCalled()
  })

  it("tokens undefined del provider degradan a 0 (no NaN en el write)", async () => {
    const h = makeHarness()
    await run(h, baseData({ usage: {} }))
    const usage = h.updateUsage.mock.calls[0][2]
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })
})

// ===========================================================================
// trackUsage — llm_usage con el fallback metadata→responseMetadata
// ===========================================================================

describe("handleMessageComplete → trackUsage", () => {
  it("payload EXACTO con provider/actualModel/generationId desde responseMetadata", async () => {
    const h = makeHarness()
    await run(
      h,
      baseData({
        sessionUsageId: "susage_1",
        responseMetadata: { provider: "openrouter", model: "claude-real-served", id: "gen_abc" },
      }),
    )

    expect(h.trackUsage).toHaveBeenCalledTimes(1)
    expect(h.trackUsage.mock.calls[0][0]).toEqual({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      coreId: "core_x",
      channelId: CHANNEL_ID,
      messageId: "msg_final0000000001",
      sessionUsageId: "susage_1",
      provider: "openrouter", // del responseMetadata, NO del agentConfig
      modelId: "model_sonnet",
      modelString: "claude-3-5-sonnet-20241022",
      actualModel: "claude-real-served",
      promptTokens: 1200,
      completionTokens: 340,
      // Processed total = non-cached input 1200 + cache reads 50 + output 340
      // (A2.1). inputTokens excludes cached; totalTokens adds it back.
      totalTokens: 1590,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
      generationId: "gen_abc",
      stopReason: "end_turn",
    })
  })

  it("FALLBACK legacy: data.metadata se usa si no hay responseMetadata, y responseMetadata GANA en colisión", async () => {
    const h = makeHarness()
    await run(h, baseData({ metadata: { provider: "legacy-prov", model: "legacy-model" } }))
    expect(h.trackUsage.mock.calls[0][0].provider).toBe("legacy-prov")
    expect(h.trackUsage.mock.calls[0][0].actualModel).toBe("legacy-model")

    const h2 = makeHarness()
    await run(
      h2,
      baseData({
        metadata: { provider: "legacy-prov", model: "legacy-model" },
        responseMetadata: { provider: "nuevo-prov" },
      }),
    )
    expect(h2.trackUsage.mock.calls[0][0].provider).toBe("nuevo-prov") // override
    expect(h2.trackUsage.mock.calls[0][0].actualModel).toBe("legacy-model") // merge conserva lo no pisado
  })

  it("sin metadata: provider cae al agentConfig y actualModel queda undefined", async () => {
    const h = makeHarness()
    await run(h, baseData())
    const params = h.trackUsage.mock.calls[0][0]
    expect(params.provider).toBe("anthropic")
    expect(params.actualModel).toBeUndefined()
  })

  it("sin savedMessages NO trackea (no hay messageId al que imputar)", async () => {
    const h = makeHarness()
    const { streamHelpers, typingManager } = makeStreamPieces()
    await handleMessageComplete(
      h.ctx,
      CHANNEL_ID,
      AGENT_ID,
      AGENT_CONFIG,
      baseData(),
      // biome-ignore lint/suspicious/noExplicitAny: streamState sin mensajes
      { savedMessages: [], currentTextContent: "" } as any,
      streamHelpers,
      typingManager,
    )
    expect(h.trackUsage).not.toHaveBeenCalled()
    // Pero updateUsage SÍ corre (presupuesto del canal no depende del mensaje)
    expect(h.updateUsage).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// recordDelta — agent_usage_sessions
// ===========================================================================

describe("handleMessageComplete → recordDelta", () => {
  it("delta EXACTO: cost null del registry → 0 (pricing_unavailable derivable), toolCallCount, actualModel", async () => {
    const h = makeHarness()
    await run(
      h,
      baseData({
        sessionUsageId: "susage_1",
        toolCalls: [{ id: "t1" }, { id: "t2" }],
        responseMetadata: { model: "modelo-sin-pricing-xyz" },
      }),
    )

    expect(h.recordDelta).toHaveBeenCalledTimes(1)
    const [sessionUsageId, delta] = h.recordDelta.mock.calls[0]
    expect(sessionUsageId).toBe("susage_1")
    expect(delta).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedReadTokens: 50,
      cachedWriteTokens: 20,
      reasoningTokens: 0,
      costUsd: 0, // estimateCostUsd → null (modelo sin pricing) → ?? 0
      llmCallCount: 1,
      toolCallCount: 2,
      actualModel: "modelo-sin-pricing-xyz",
      // TER-615 M3 fix: stopReason now flows (was lost) — falls back to
      // responseMetadata.finishReason when data.stopReason is set it wins.
      stopReason: "end_turn",
      usagePartial: undefined,
      tokenBreakdown: undefined,
    })
  })

  it("usagePartial: true cuando el provider devolvió 0/0 tokens", async () => {
    const h = makeHarness()
    await run(h, baseData({ sessionUsageId: "susage_1", usage: {} }))
    expect(h.recordDelta.mock.calls[0][1].usagePartial).toBe(true)
  })

  it("usagePartial: undefined si SOLO uno de los dos lados es 0 (AND estricto, gap A5)", async () => {
    const h = makeHarness()
    await run(h, baseData({ sessionUsageId: "susage_1", usage: { outputTokens: 340 } }))
    expect(h.recordDelta.mock.calls[0][1].usagePartial).toBeUndefined()
  })

  it("sin sessionUsageId NO emite delta (turno no instrumentado)", async () => {
    const h = makeHarness()
    await run(h, baseData())
    expect(h.recordDelta).not.toHaveBeenCalled()
  })

  it("un recordDelta que lanza NO rompe el turno (fire-and-forget)", async () => {
    const h = makeHarness()
    h.recordDelta.mockImplementation(() => {
      throw new Error("buffer caído")
    })
    await run(h, baseData({ sessionUsageId: "susage_1" }))
    // El flujo continuó hasta el budget (calculateBudget se llamó)
    expect(h.ctx.usageService.calculateBudget).toHaveBeenCalled()
  })

  it("budget NULL no broadcastea token_budget (gap A9)", async () => {
    const h = makeHarness() // calculateBudget → null por defecto
    await run(h, baseData())
    const tokenBudgetCalls = h.broadcastToChannel.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: inspección de llamadas
      (c: any[]) => c[1]?.type === "token_budget",
    )
    expect(tokenBudgetCalls).toEqual([])
  })

  it("budget no nulo se broadcastea como token_budget", async () => {
    const h = makeHarness()
    h.ctx.usageService.calculateBudget.mockImplementation(async () => ({
      totalUsed: 100,
      modelLimit: 200000,
      percentUsed: 0.05,
    }))
    await run(h, baseData())
    expect(h.broadcastToChannel).toHaveBeenCalledWith(CHANNEL_ID, {
      type: "token_budget",
      channelId: CHANNEL_ID,
      budget: { totalUsed: 100, modelLimit: 200000, percentUsed: 0.05 },
    })
  })
})

// ===========================================================================
// classifyError — casos NO cubiertos por agent-usage-flow.test.ts
// ===========================================================================

describe("classifyError (complemento: session + heurísticas de message)", () => {
  it.each([
    [{ type: "session_lock" }, "session_error"],
    [{ message: "Turn interrupted by new message" }, "aborted_by_user"],
    [{ message: "request timeout exceeded" }, "reconciled_timeout"],
    [null, "unknown"],
    ["string suelto", "unknown"],
    [{ name: "FetchError" }, "network_error"], // .name también clasifica
  ])("clasifica %p → %p", (err, expected) => {
    expect(classifyError(err)).toBe(expected as string)
  })
})
