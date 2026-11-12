/**
 * Onboarding: the model an agent gets must accept tools (ONB v2.1.0).
 *
 * Found on the demo (2026-11-09): a completion-only Ollama model
 * (mythomax-l2-13b) was the first model listed, passed the text-only probe,
 * and Iria's first chat failed with "does not support tools".
 *
 * - ONB-AC-9: the probe offers one tool; a tools error fails it; a tool call counts as an answer.
 * - ONB-AC-10: Ollama discovery reads /api/show capabilities and lists tool models first.
 * - ONB-AC-11: agent.set-model refuses a model marked tools: false.
 */

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { LLMClientFactory } from "@teros/core"
import type { WsHandlerContext } from "@teros/shared"
import { ProviderService } from "../../src/services/provider-service"
import { createSetModelHandler } from "../../src/handlers/domains/agent/set-model"
import { InMemoryDb } from "./_stripe-test-helpers"

const tagEntry = (name: string) => ({
  name,
  model: name,
  size: 1_000,
  details: { family: "llama", parameter_size: "13B", quantization_level: "Q4_K_M" },
})

const CAPABILITIES: Record<string, string[]> = {
  "nollama/mythomax-l2-13b:Q4_K_M": ["completion"],
  "qwen3-coder:30b": ["completion", "tools"],
}

const originalFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = originalFetch
})

/** Stub the daemon: /api/tags lists mythomax first, /api/show answers per model. */
function stubOllamaDaemon(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    if (url.endsWith("/api/tags")) {
      return json({ models: Object.keys(CAPABILITIES).map(tagEntry) })
    }
    if (url.endsWith("/api/show")) {
      const { model } = JSON.parse(String(init?.body ?? "{}"))
      return json({ capabilities: CAPABILITIES[model] })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

async function makeOllamaProvider(db: InMemoryDb) {
  const svc = new ProviderService(db as any)
  const provider = await svc.addProvider("user_oll", {
    providerType: "ollama",
    displayName: "Ollama Local",
    config: { baseUrl: "http://localhost:11434" },
  })
  return { svc, provider }
}

describe("Ollama discovery reads tool support", () => {
  it("[ONB-AC-10] marks completion-only models tools: false and lists tool models first", async () => {
    stubOllamaDaemon()
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId)

    expect(result.ok).toBe(true)
    const models = (result.models ?? []).map((m) => [m.modelString, m.capabilities.tools])
    expect(models).toEqual([
      ["qwen3-coder:30b", true],
      ["nollama/mythomax-l2-13b:Q4_K_M", false],
    ])
  })
})

describe("The onboarding probe offers a tool", () => {
  let createSpy: ReturnType<typeof spyOn> | undefined
  afterEach(() => createSpy?.mockRestore())

  function fakeClient(stream: (opts: any) => Promise<void>) {
    const seen: any[] = []
    createSpy = spyOn(LLMClientFactory, "create").mockImplementation((async () => ({
      getProviderInfo: () => ({ provider: "ollama" }),
      streamMessage: async (opts: any) => {
        seen.push(opts)
        await stream(opts)
      },
    })) as any)
    return seen
  }

  it("[ONB-AC-9] sends exactly one tool definition and returns the text reply", async () => {
    stubOllamaDaemon()
    const seen = fakeClient(async (opts) => opts.callbacks.onText("Hola, soy Iria."))
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId, { probe: true })

    expect(seen).toHaveLength(1)
    expect(seen[0].tools).toHaveLength(1)
    expect(result).toMatchObject({ ok: true, reply: "Hola, soy Iria." })
  })

  it("[ONB-AC-9] fails with the provider's error when the model rejects tools", async () => {
    stubOllamaDaemon()
    fakeClient(async () => {
      throw new Error("Ollama request error: 400 mythomax does not support tools")
    })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId, { probe: true })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("does not support tools")
  })

  it("[ONB-AC-9] counts a tool call without text as answered", async () => {
    stubOllamaDaemon()
    fakeClient(async (opts) => opts.callbacks.onToolCall({ id: "t1", name: "get_current_time", input: {} }))
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId, { probe: true })

    expect(result.ok).toBe(true)
    expect(result.reply).toBeUndefined()
  })
})

describe("agent.set-model refuses models without tools", () => {
  it("[ONB-AC-11] throws MODEL_WITHOUT_TOOLS and leaves the agent unchanged", async () => {
    const providers = [
      {
        providerId: "oll",
        userId: "user_a",
        providerType: "ollama",
        models: [
          { modelId: "ollama-qwen", modelString: "qwen3-coder:30b", capabilities: { tools: true } },
          { modelId: "ollama-mytho", modelString: "mythomax", capabilities: { tools: false } },
        ],
      },
    ]
    const updateOne = mock(async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }))
    const db = {
      collection: (name: string) =>
        name === "agents"
          ? { findOne: async () => ({ agentId: "ag", ownerId: "user_a" }), updateOne }
          : {
              find: (filter: any) => ({
                toArray: async () => providers.filter((p) => filter.providerId.$in.includes(p.providerId)),
              }),
              findOne: async (filter: any) => providers.find((p) => p.providerId === filter.providerId) ?? null,
            },
    } as any
    const ctx = { userId: "user_a", connectionId: "c", sessionId: "s" } as WsHandlerContext
    const setModel = createSetModelHandler(db)

    await expect(setModel(ctx, { agentId: "ag", providerId: "oll", modelId: "ollama-mytho" })).rejects.toMatchObject({
      code: "MODEL_WITHOUT_TOOLS",
    })
    expect(updateOne).not.toHaveBeenCalled()

    await setModel(ctx, { agentId: "ag", providerId: "oll", modelId: "ollama-qwen" })
    expect(updateOne).toHaveBeenCalledTimes(1)
  })
})
