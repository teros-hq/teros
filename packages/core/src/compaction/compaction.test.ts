/**
 * CompactionService — unit + invariante INV-1 (TER-454).
 *
 * Corrupción silenciosa de contexto de alto blast-radius: un prune que mutara
 * los originales corrompería la DB; un split que dejara orphan tool parts
 * rompería el siguiente LLM call (los adapters lanzan sobre tool_use sin
 * result). Mock del LLM fiel a ILLMClient.streamMessage (callbacks.onText).
 */

import { describe, expect, it } from "bun:test"
import type { ILLMClient } from "../llm/ILLMClient"
import { countTokensForProvider } from "../llm/token-counter"
import { assertInvariantINV1 } from "../prompts/PromptBuilder"
import type { MessageWithParts, ToolState } from "../session/types"
import {
  CompactionService,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateStaticPromptTokens,
  estimateTokens,
} from "./index"

// ============================================================================
// Fixtures — shapes reales de session/types.ts
// ============================================================================

let seq = 0

function textMsg(role: "user" | "assistant", text: string): MessageWithParts {
  const id = `message_${++seq}`
  return {
    info: { id, sessionID: "session_test", role, time: { created: seq } } as any,
    parts: [{ id: `part_${seq}`, sessionID: "session_test", messageID: id, type: "text", text }],
  }
}

function toolMsg(
  output: string,
  status: "completed" | "error" = "completed",
  input: unknown = { cmd: "ls" },
): MessageWithParts {
  const id = `message_${++seq}`
  const state: ToolState =
    status === "completed"
      ? {
          status: "completed",
          input: input as Record<string, any>,
          output,
          title: "bash",
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : {
          status: "error",
          input: input as Record<string, any>,
          error: "boom",
          metadata: {},
          time: { start: 1, end: 2 },
        }
  // El prune lee state.output también en error parts (campo no tipado ahí):
  const finalState = status === "error" ? ({ ...state, output } as any) : state
  return {
    info: { id, sessionID: "session_test", role: "assistant", time: { created: seq } } as any,
    parts: [
      {
        id: `part_${seq}`,
        sessionID: "session_test",
        messageID: id,
        type: "tool",
        tool: "bash",
        callID: `call_${seq}`,
        state: finalState,
      },
    ],
  }
}

/** Mock fiel al boundary ILLMClient.streamMessage: emite chunks por onText. */
function mockLLM(chunks: string[] = ["resumen ", "generado"]) {
  const calls: Array<{ systemPrompt?: string; promptText: string }> = []
  const client = {
    streamMessage: async (args: any) => {
      const promptText = args.messages?.[0]?.parts?.[0]?.text ?? ""
      calls.push({ systemPrompt: args.systemPrompt, promptText })
      for (const c of chunks) args.callbacks?.onText?.(c)
      return { usage: { inputTokens: 42, outputTokens: 7 } }
    },
  } as unknown as ILLMClient
  return { client, calls }
}

function service(
  llm: ILLMClient,
  cfg: Partial<{
    triggerAt: number
    targetSize: number
    protectRecent: number
    contextSize: number
    prune: { minSavings: number; protectRecent: number; enabled: boolean }
    provider: string
  }> = {},
) {
  return new CompactionService(llm, {
    triggerAt: cfg.triggerAt ?? 1000,
    targetSize: cfg.targetSize ?? 600,
    protectRecent: cfg.protectRecent ?? 100,
    contextSize: cfg.contextSize ?? 2000,
    prune: cfg.prune,
    provider: cfg.provider,
  })
}

// ============================================================================
// Token estimation — valores EXACTOS (CHARS_PER_TOKEN=2.5, ceil, overhead 10)
// ============================================================================

describe("estimateTokens", () => {
  it.each([
    ["ab", 1], // ceil(2/2.5)
    ["abcde", 2],
    ["", 0],
    ["x", 1],
  ])("%p → %p", (text, expected) => {
    expect(estimateTokens(text as string)).toBe(expected as number)
  })

  it("null/undefined degradan a 0", () => {
    expect(estimateTokens(null as any)).toBe(0)
    expect(estimateTokens(undefined as any)).toBe(0)
  })
})

describe("estimateMessageTokens", () => {
  it("text part: ceil(len/2.5) + overhead 10", () => {
    expect(estimateMessageTokens(textMsg("user", "x".repeat(25)))).toBe(20) // 10 + 10
  })

  it("tool part: name + input JSON + output, exacto", () => {
    // 'bash'=2 + '{"cmd":"ls"}'(12 chars)=5 + output 25 chars=10 + overhead 10 = 27
    expect(estimateMessageTokens(toolMsg("y".repeat(25)))).toBe(27)
  })

  it("conversación = suma de mensajes", () => {
    const msgs = [textMsg("user", "x".repeat(25)), toolMsg("y".repeat(25))]
    expect(estimateConversationTokens(msgs)).toBe(47)
  })
})

// ============================================================================
// estimateStaticPromptTokens — coste fijo del turno (CTX-001)
// ============================================================================

describe("estimateStaticPromptTokens (CTX-001)", () => {
  it("undefined → 0", () => {
    expect(estimateStaticPromptTokens()).toBe(0)
  })

  it("objeto vacío → 0", () => {
    expect(estimateStaticPromptTokens({})).toBe(0)
  })

  it("system vacío no suma (guard truthy)", () => {
    expect(estimateStaticPromptTokens({ system: "" })).toBe(0)
    expect(estimateStaticPromptTokens({ memory: "" })).toBe(0)
  })

  it("suma system + tools(JSON) + memory EXACTO", () => {
    const tools = [{ name: "bash" }]
    const toolsTokens = estimateTokens(JSON.stringify(tools)) // '[{"name":"bash"}]'
    // system 25 chars → 10; memory 25 chars → 10
    expect(
      estimateStaticPromptTokens({ system: "x".repeat(25), tools, memory: "y".repeat(25) }),
    ).toBe(10 + toolsTokens + 10)
  })

  it("tools se serializan con JSON.stringify (array vacío = '[]' = 1 token)", () => {
    expect(estimateStaticPromptTokens({ tools: [] })).toBe(estimateTokens("[]"))
    expect(estimateStaticPromptTokens({ tools: [] })).toBe(1)
  })
})

// ============================================================================
// Estimador provider-aware — enruta al tokenizer BPE real (CTX-003)
// ============================================================================

describe("estimateTokens provider-aware (CTX-003)", () => {
  it("sin provider → char heuristic ceil(len/2.5)", () => {
    expect(estimateTokens("x".repeat(25))).toBe(10)
  })

  it("con provider → BPE real (== countTokensForProvider), distinto del char", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20)
    const bpe = estimateTokens(text, "anthropic")
    expect(bpe).toBe(countTokensForProvider(text, "anthropic"))
    expect(bpe).toBeGreaterThan(0)
    // BPE de prosa (~4-5 char/token) cuenta MENOS que el heuristic 2.5 char/token
    expect(bpe).toBeLessThan(estimateTokens(text))
  })

  it("estimateConversationTokens propaga el provider a cada mensaje", () => {
    const msgs = [
      textMsg("user", "hello world ".repeat(30)),
      textMsg("assistant", "sure thing ".repeat(30)),
    ]
    const withProvider = estimateConversationTokens(msgs, "anthropic")
    expect(withProvider).not.toBe(estimateConversationTokens(msgs))
    expect(withProvider).toBe(
      msgs.reduce((t, m) => t + estimateMessageTokens(m, "anthropic"), 0),
    )
  })

  it("estimateStaticPromptTokens propaga el provider (tools serializados en BPE)", () => {
    const tools = [{ name: "bash", description: "run a shell command" }]
    expect(estimateStaticPromptTokens({ tools }, "anthropic")).toBe(
      countTokensForProvider(JSON.stringify(tools), "anthropic"),
    )
  })
})

describe("CompactionService usa config.provider (CTX-003)", () => {
  it("checkNeedsCompaction con provider cuenta en BPE, no en char (misma escala en todo el servicio)", () => {
    const msgs = [textMsg("user", "The quick brown fox. ".repeat(40))]
    const { client } = mockLLM()
    const charTokens = service(client, { triggerAt: 999999 }).checkNeedsCompaction(msgs)
      .currentTokens
    const bpeTokens = service(client, { triggerAt: 999999, provider: "anthropic" })
      .checkNeedsCompaction(msgs).currentTokens
    expect(bpeTokens).toBeGreaterThan(0)
    expect(bpeTokens).not.toBe(charTokens)
    expect(bpeTokens).toBeLessThan(charTokens)
  })
})

// ============================================================================
// checkNeedsCompaction — boundary >= threshold
// ============================================================================

describe("checkNeedsCompaction", () => {
  it("dispara EXACTAMENTE en el threshold (>=, no >)", () => {
    const msgs = [textMsg("user", "x".repeat(25))] // 20 tokens
    const { client } = mockLLM()
    expect(service(client, { triggerAt: 20 }).checkNeedsCompaction(msgs).shouldCompact).toBe(true)
    expect(service(client, { triggerAt: 21 }).checkNeedsCompaction(msgs).shouldCompact).toBe(false)
  })

  it("reporta currentTokens y threshold exactos", () => {
    const msgs = [textMsg("user", "x".repeat(25)), textMsg("assistant", "y".repeat(25))]
    const { client } = mockLLM()
    const check = service(client, { triggerAt: 999 }).checkNeedsCompaction(msgs)
    expect(check.currentTokens).toBe(40)
    expect(check.threshold).toBe(999)
    expect(check.shouldCompact).toBe(false)
  })

  // ── CTX-001: el trigger debe contar el coste fijo del turno (system+tools+memory)
  it("CTX-001: el coste estático dispara aunque los mensajes solos NO alcancen el threshold", () => {
    const msgs = [textMsg("user", "x".repeat(25))] // 20 tokens
    const { client } = mockLLM()
    const staticComponents = { system: "s".repeat(50) } // ceil(50/2.5)=20 tokens estáticos
    // Sin estático: 20 < 35 → NO dispara (el bug viejo: trigger ciego a system+tools)
    expect(service(client, { triggerAt: 35 }).checkNeedsCompaction(msgs).shouldCompact).toBe(false)
    // Con estático: 20 + 20 = 40 >= 35 → dispara
    const check = service(client, { triggerAt: 35 }).checkNeedsCompaction(msgs, staticComponents)
    expect(check.currentTokens).toBe(40)
    expect(check.shouldCompact).toBe(true)
  })

  it("CTX-001: los esquemas de tools cuentan (JSON.stringify) hacia currentTokens", () => {
    const msgs = [textMsg("user", "x".repeat(25))] // 20
    const { client } = mockLLM()
    const tools = [{ name: "bash", description: "d".repeat(100) }]
    const toolsTokens = estimateTokens(JSON.stringify(tools))
    expect(toolsTokens).toBeGreaterThan(0)
    const check = service(client, { triggerAt: 9999 }).checkNeedsCompaction(msgs, { tools })
    expect(check.currentTokens).toBe(20 + toolsTokens)
  })

  it("CTX-001: staticComponents omitido → currentTokens = solo mensajes (retrocompatible)", () => {
    const msgs = [textMsg("user", "x".repeat(25)), textMsg("assistant", "y".repeat(25))] // 40
    const { client } = mockLLM()
    const check = service(client, { triggerAt: 999 }).checkNeedsCompaction(msgs)
    expect(check.currentTokens).toBe(40)
    expect(check.shouldCompact).toBe(false)
  })

  it("BOUNDARY CTX-001: mensajes+estático EXACTAMENTE == threshold dispara (>=, no >)", () => {
    const msgs = [textMsg("user", "x".repeat(25))] // 20
    const { client } = mockLLM()
    const staticComponents = { memory: "m".repeat(25) } // 10 → total 30
    expect(
      service(client, { triggerAt: 30 }).checkNeedsCompaction(msgs, staticComponents).shouldCompact,
    ).toBe(true)
    expect(
      service(client, { triggerAt: 31 }).checkNeedsCompaction(msgs, staticComponents).shouldCompact,
    ).toBe(false)
  })

  it("CTX-001: protectedTokens es independiente del coste estático (protege mensajes, no overhead)", () => {
    const msgs = [textMsg("user", "x".repeat(25))] // 20 tokens, cabe en protectRecent=100
    const { client } = mockLLM()
    const withoutStatic = service(client, { triggerAt: 999, protectRecent: 100 }).checkNeedsCompaction(msgs)
    const withStatic = service(client, {
      triggerAt: 999,
      protectRecent: 100,
    }).checkNeedsCompaction(msgs, { system: "s".repeat(500) })
    expect(withStatic.protectedTokens).toBe(withoutStatic.protectedTokens)
    expect(withStatic.protectedTokens).toBe(20)
  })
})

// ============================================================================
// prune — protección, placeholder exacto, inmutabilidad, idempotencia
// ============================================================================

describe("prune", () => {
  const BIG = 1000 // 400 tokens por output

  it("disabled → devuelve la MISMA referencia sin cambios", () => {
    const msgs = [toolMsg("A".repeat(BIG))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: false, minSavings: 1, protectRecent: 0 } })
    const { messages, result } = svc.prune(msgs)
    expect(messages).toBe(msgs)
    expect(result.pruned).toBe(false)
    expect(result.tokensSaved).toBe(0)
  })

  it("savings < minSavings → no-op con la misma referencia", () => {
    const msgs = [toolMsg("A".repeat(BIG)), toolMsg("B".repeat(BIG))]
    const { client } = mockLLM()
    // backwards: B se protege (0<10), A podable = 400 tokens < minSavings 401
    const svc = service(client, { prune: { enabled: true, minSavings: 401, protectRecent: 10 } })
    const { messages, result } = svc.prune(msgs)
    expect(messages).toBe(msgs)
    expect(result.pruned).toBe(false)
  })

  it("poda outputs viejos con placeholder EXACTO y deja intactos los protegidos", () => {
    const oldOutput = "A".repeat(BIG)
    const recentOutput = "B".repeat(BIG)
    const msgs = [toolMsg(oldOutput), toolMsg(recentOutput)]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 100, protectRecent: 10 } })
    const { messages, result } = svc.prune(msgs)

    expect(result).toEqual({
      pruned: true,
      partsPruned: 1,
      tokensBefore: estimateConversationTokens(msgs),
      tokensAfter: estimateConversationTokens(messages),
      tokensSaved: estimateConversationTokens(msgs) - estimateConversationTokens(messages),
    })
    const prunedState = (messages[0].parts[0] as any).state
    expect(prunedState.output).toBe(`[Output pruned - completed] ${"A".repeat(200)}...`)
    expect((messages[1].parts[0] as any).state.output).toBe(recentOutput)
  })

  it('output ≤200 chars podado NO lleva sufijo "..."', () => {
    // backwards: el reciente (300 chars=120 tokens) se protege; el viejo (150) se poda
    const msgs = [toolMsg("C".repeat(150)), toolMsg("D".repeat(300))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 1, protectRecent: 10 } })
    const { messages } = svc.prune(msgs)
    expect((messages[0].parts[0] as any).state.output).toBe(
      `[Output pruned - completed] ${"C".repeat(150)}`,
    )
  })

  it('tool con status error → prefijo "[Output pruned - error]"', () => {
    const msgs = [toolMsg("E".repeat(BIG), "error"), toolMsg("F".repeat(BIG))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 100, protectRecent: 10 } })
    const { messages } = svc.prune(msgs)
    expect((messages[0].parts[0] as any).state.output).toBe(
      `[Output pruned - error] ${"E".repeat(200)}...`,
    )
  })

  it("NO muta los mensajes originales (la DB retiene historia completa)", () => {
    const original = "A".repeat(BIG)
    const msgs = [toolMsg(original), toolMsg("B".repeat(BIG))]
    const snapshot = JSON.parse(JSON.stringify(msgs))
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 100, protectRecent: 10 } })
    svc.prune(msgs)
    expect(msgs).toEqual(snapshot)
  })

  it("el output que CRUZA protectRecent también se protege (check antes de sumar)", () => {
    // backwards: out3 (400tk, 0<500 → protege), out2 (400tk, 400<500 → protege),
    // out1 (800>=500 → poda). Solo el más viejo cae.
    const msgs = [toolMsg("A".repeat(BIG)), toolMsg("B".repeat(BIG)), toolMsg("C".repeat(BIG))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 1, protectRecent: 500 } })
    const { messages, result } = svc.prune(msgs)
    expect(result.partsPruned).toBe(1)
    expect((messages[0].parts[0] as any).state.output).toStartWith("[Output pruned")
    expect((messages[1].parts[0] as any).state.output).toBe("B".repeat(BIG))
    expect((messages[2].parts[0] as any).state.output).toBe("C".repeat(BIG))
  })

  it("tool sin output se salta (ni protege ni poda)", () => {
    const noOutput = toolMsg("")
    const msgs = [noOutput, toolMsg("A".repeat(BIG)), toolMsg("B".repeat(BIG))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 100, protectRecent: 10 } })
    const { messages, result } = svc.prune(msgs)
    expect(result.partsPruned).toBe(1) // solo el del medio
    expect((messages[0].parts[0] as any).state.output).toBe("")
  })

  it("BOUNDARY: prunable EXACTAMENTE == minSavings NO poda (el gate es <, no <=) — caza < mutado a <=", () => {
    // viejo: 1000 chars = 400 tokens prunable; minSavings = 400 → 400 < 400 falso → poda
    const msgs = [toolMsg("A".repeat(1000)), toolMsg("B".repeat(1000))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 400, protectRecent: 10 } })
    const { result } = svc.prune(msgs)
    expect(result.pruned).toBe(true)
    expect(result.partsPruned).toBe(1)
  })

  it('BOUNDARY: output podado de EXACTAMENTE 200 chars no lleva "..." (el sufijo exige > 200)', () => {
    const msgs = [toolMsg("G".repeat(200)), toolMsg("H".repeat(2000))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 1, protectRecent: 10 } })
    const { messages } = svc.prune(msgs)
    expect((messages[0].parts[0] as any).state.output).toBe(
      `[Output pruned - completed] ${"G".repeat(200)}`,
    )
  })

  it("es idempotente con el minSavings DEFAULT (20K): la 2ª pasada no llega al umbral", () => {
    // outputs de 110K chars = 44K tokens: el reciente llena protectRecent
    // (40K default) y el viejo queda podable (44K > 20K minSavings default)
    const msgs = [toolMsg("A".repeat(110_000)), toolMsg("B".repeat(110_000))]
    const { client } = mockLLM()
    const svc = service(client, {}) // prune por DEFAULT_PRUNE_CONFIG
    const first = svc.prune(msgs)
    expect(first.result.pruned).toBe(true)
    // el placeholder (~231 chars ≈ 93 tokens) queda MUY por debajo de 20K
    const second = svc.prune(first.messages)
    expect(second.result.pruned).toBe(false)
    expect(second.messages).toBe(first.messages)
  })

  it("CHARACTERIZATION: con minSavings bajo NO es idempotente — re-poda placeholders anidando prefijos", () => {
    // No alcanzable en producción: nadie encadena prune→prune (cada turno
    // parte de los originales de la DB) y el default 20K exige >215
    // placeholders para re-disparar. Si algún día se encadena, el fix es
    // saltar outputs que ya empiezan por '[Output pruned'.
    const msgs = [toolMsg("A".repeat(BIG)), toolMsg("B".repeat(BIG)), toolMsg("C".repeat(BIG))]
    const { client } = mockLLM()
    const svc = service(client, { prune: { enabled: true, minSavings: 100, protectRecent: 10 } })
    const first = svc.prune(msgs)
    expect(first.result.pruned).toBe(true)
    const second = svc.prune(first.messages)
    expect(second.result.pruned).toBe(true) // re-poda
    expect((second.messages[0].parts[0] as any).state.output).toStartWith(
      "[Output pruned - completed] [Output pruned - completed]",
    )
  })
})

// ============================================================================
// compact — dos fases, summary exacto, error del LLM, INV-1
// ============================================================================

describe("compact", () => {
  it("prune suficiente (< targetSize) → success SIN llamar al LLM", async () => {
    const msgs = [toolMsg("A".repeat(1000)), toolMsg("B".repeat(1000))]
    const { client, calls } = mockLLM()
    const svc = service(client, {
      targetSize: 100_000,
      prune: { enabled: true, minSavings: 100, protectRecent: 10 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(true)
    expect(result.summary).toBeUndefined()
    expect(result.messagesCompacted).toBe(0)
    expect(result.pruneResult?.pruned).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it("genera el summary EXACTO (chunks de onText concatenados) y cuenta compactados", async () => {
    // 10 mensajes de 20 tokens; protectRecent 50 → protege los 2 últimos
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 ? "assistant" : "user", "x".repeat(25)),
    )
    const { client, calls } = mockLLM(["parte1 ", "parte2"])
    const svc = service(client, {
      targetSize: 1, // prune nunca basta
      protectRecent: 50,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(true)
    expect(result.summary).toBe("parte1 parte2")
    expect(result.messagesCompacted).toBe(8)
    expect(calls).toHaveLength(1)
    expect(calls[0].systemPrompt).toBe(
      "You are a precise conversation summarizer. Create concise but complete summaries.",
    )
    expect(calls[0].promptText).toContain("CONVERSATION TO SUMMARIZE")
    expect(calls[0].promptText).toContain("x".repeat(25))
  })

  it("tokensAfter = summary + protegidos (estimación exacta)", async () => {
    const msgs = Array.from({ length: 10 }, () => textMsg("user", "x".repeat(25)))
    const { client } = mockLLM(["s".repeat(25)]) // summary 25 chars = 10 tokens
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 50,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    // 2 mensajes protegidos × 20 + summary 10
    expect(result.tokensAfter).toBe(50)
    expect(result.tokensBefore).toBe(200)
  })

  it("TER-707/CTX-016: bounds a HUGE error-part input in the summarization prompt (review-2 N3/F5)", async () => {
    // `error` parts are E1-exempt in the main history path (the model needs
    // the full args to self-correct) — but that exemption must NOT apply
    // here: the summarizer's one-shot prompt has no auto-correction concept,
    // and an unbound error input can overflow the emergency-compaction
    // backstop itself (the exact fallo duro review-2 flagged).
    const bigInput = { cmd: "x".repeat(50_000) }
    // The big tool part must NOT be the last message: splitMessages always
    // protects at least the trailing message from summarization, regardless
    // of protectRecent — put a small message after it so it lands in
    // `toCompact` (the batch that actually goes through formatMessagesForSummary).
    const msgs = [
      ...Array.from({ length: 4 }, () => textMsg("user", "x".repeat(25))),
      toolMsg("failed", "error", bigInput),
      ...Array.from({ length: 4 }, () => textMsg("user", "x".repeat(25))),
    ]
    const { client, calls } = mockLLM(["resumen"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 0,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    const rawInput = JSON.stringify(bigInput, null, 2)
    expect(calls[0].promptText).not.toContain(rawInput)
    expect(calls[0].promptText.length).toBeLessThan(rawInput.length)
  })

  it("error del LLM → success:false con error.message, sin lanzar", async () => {
    const msgs = Array.from({ length: 10 }, () => textMsg("user", "x".repeat(25)))
    const failing = {
      streamMessage: async () => {
        throw new Error("rate limited")
      },
    } as unknown as ILLMClient
    const svc = service(failing, {
      targetSize: 1,
      protectRecent: 50,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(false)
    expect(result.error).toBe("rate limited")
    expect(result.messagesCompacted).toBe(0)
    expect(result.tokensAfter).toBe(result.pruneResult?.tokensAfter)
  })

  it("si protegería todo menos ≤2 mensajes → no compacta (toCompact vacío, sin LLM)", async () => {
    const msgs = [textMsg("user", "x".repeat(25)), textMsg("assistant", "y".repeat(25))]
    const { client, calls } = mockLLM()
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 1, // cada mensaje cruza → protectFromIndex = len-1 = 1 ≤ 2
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(true)
    expect(result.messagesCompacted).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("BOUNDARY: tokensAfterPrune EXACTAMENTE == targetSize NO basta → va al LLM (el gate es <, no <=)", async () => {
    // 10 mensajes × 20 tokens = 200; targetSize = 200 → 200 < 200 falso → LLM
    const msgs = Array.from({ length: 10 }, () => textMsg("user", "x".repeat(25)))
    const { client, calls } = mockLLM(["s"])
    const svc = service(client, {
      targetSize: 200,
      protectRecent: 50,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(calls).toHaveLength(1)
    expect(result.messagesCompacted).toBe(8)
  })

  it("BOUNDARY del split: el mensaje que SUMA exacto protectRecent se protege (cruce estricto >)", async () => {
    // 10 × 20 tokens; protectRecent=40: backwards 20, 40 (== no cruza), 60 cruza
    // → protege 2, compacta 8. Mutar > a >= protegería solo 1 (compactaría 9).
    const msgs = Array.from({ length: 10 }, () => textMsg("user", "x".repeat(25)))
    const { client } = mockLLM(["s"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 40,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.messagesCompacted).toBe(8)
  })

  it("BOUNDARY: protectFromIndex EXACTO == 2 tampoco compacta (el gate es <=, no <)", async () => {
    // 5 × 20 tokens; protectRecent=65: backwards 20,40,60 (≤65), 80 cruza en
    // i=1 → protectFromIndex=2 → ≤2 → no compacta ni llama al LLM.
    const msgs = Array.from({ length: 5 }, () => textMsg("user", "x".repeat(25)))
    const { client, calls } = mockLLM(["s"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 65,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.messagesCompacted).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("CHARACTERIZATION: conversación que cabe ENTERA en protectRecent igualmente compacta todo menos el último", async () => {
    // splitMessages: si el loop nunca cruza protectRecent, protectFromIndex
    // queda en messages.length y el ajuste lo fuerza a len-1 → compacta len-1
    // mensajes aunque cupieran. Solo alcanzable vía emergency compaction
    // (TurnDriver llama compact() sin check de threshold) — comportamiento
    // agresivo defendible tras un 'prompt too long' del provider.
    const msgs = Array.from({ length: 5 }, () => textMsg("user", "x".repeat(25)))
    const { client, calls } = mockLLM(["s"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 1_000_000,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.messagesCompacted).toBe(4)
    expect(calls).toHaveLength(1)
  })

  it("INV-1: la ventana protegida tras el corte (slice del TurnDriver) queda sin orphans", async () => {
    // Conversación válida: tool parts completed + texto. Tras compact, el
    // TurnDriver hace messages.slice(-(len - messagesCompacted)); esa ventana
    // debe pasar assertInvariantINV1 (los adapters lanzan sobre orphans).
    const msgs = [
      textMsg("user", "x".repeat(250)),
      toolMsg("A".repeat(250)),
      textMsg("assistant", "y".repeat(250)),
      textMsg("user", "z".repeat(250)),
      toolMsg("B".repeat(250)),
      textMsg("assistant", "w".repeat(250)),
    ]
    expect(assertInvariantINV1(msgs).ok).toBe(true)
    const { client } = mockLLM(["resumen"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 250, // protege los 2 últimos (110+125 < 250; +125 cruza)
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    expect(result.success).toBe(true)
    expect(result.messagesCompacted).toBeGreaterThan(0)
    const protectedWindow = msgs.slice(-(msgs.length - result.messagesCompacted))
    expect(assertInvariantINV1(protectedWindow).ok).toBe(true)
  })

  it("INV-1: un orphan running en zona vieja desaparece de la ventana al compactarse", async () => {
    const orphan = toolMsg("ignored")
    ;(orphan.parts[0] as any).state = { status: "running", input: {}, time: { start: 1 } }
    const msgs = [
      orphan, // viejo, orphan
      ...Array.from({ length: 6 }, () => textMsg("user", "x".repeat(250))),
    ]
    expect(assertInvariantINV1(msgs).ok).toBe(false)
    const { client } = mockLLM(["resumen"])
    const svc = service(client, {
      targetSize: 1,
      protectRecent: 250,
      prune: { enabled: false, minSavings: 1, protectRecent: 0 },
    })
    const result = await svc.compact(msgs)
    const protectedWindow = msgs.slice(-(msgs.length - result.messagesCompacted))
    expect(assertInvariantINV1(protectedWindow).ok).toBe(true)
  })
})
