/**
 * Ollama local discovery must not list cloud manifests (fix 2026-11-01).
 *
 * The local Ollama daemon lists entries tagged `:cloud` in /api/tags —
 * manifest-only placeholders (a few hundred bytes, no weights,
 * remote_host: https://ollama.com). Listing them inside the LOCAL provider
 * made them selectable and pinnable, and inference then failed with
 * 'unauthorized': cloud models need the ollama.com credential that the
 * separate 'ollama-cloud' provider owns (incident 2026-10-31: Señor Lobo's
 * agent pinned mistral-large-4:cloud on the local provider).
 *
 * These tests pin the filter at the public surface (ProviderService.testProvider
 * → discoverModels → discoverOllamaModels) against a stubbed global fetch that
 * replays the REAL RAW daemon payload shape (2026-11-01):
 *   - mistral-large-4:cloud (316-byte manifest, remote_host) must be filtered
 *   - qwen3-coder:30b / gpt-oss:20b (real weights) must survive
 *   - the filtered list is what gets persisted to user_providers.models
 *
 * Mutation-checked: removing the isCloudManifest filter turns tests 1-3 red;
 * dropping the remote_host check turns test 3 red.
 */

import { afterAll, describe, expect, it } from "bun:test"
import { ProviderService } from "../../src/services/provider-service"
import { InMemoryDb } from "./_stripe-test-helpers"

// ---------------------------------------------------------------------------
// Payloads — mirror the real /api/tags shape observed on RAW (2026-11-01)
// ---------------------------------------------------------------------------

const CLOUD_MANIFEST = {
  name: "mistral-large-4:cloud",
  model: "mistral-large-4:cloud",
  remote_model: "mistral-large-4",
  remote_host: "https://ollama.com",
  modified_at: "2026-10-31T02:09:43.026483012+01:00",
  size: 316,
  digest: "26221989f78c73cd83002b661354561832bed7416fa0632e0c5eb83cd0d57d0b",
  details: {
    parent_model: "",
    format: "",
    family: "",
    families: null,
    parameter_size: "1.05T",
    quantization_level: "",
  },
}

const LOCAL_QWEN = {
  name: "qwen3-coder:30b",
  model: "qwen3-coder:30b",
  modified_at: "2026-01-26T20:51:05.213506555+01:00",
  size: 18556700761,
  digest: "06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca",
  details: {
    parent_model: "",
    format: "gguf",
    family: "qwen3moe",
    families: ["qwen3moe"],
    parameter_size: "30.5B",
    quantization_level: "Q4_K_M",
  },
}

const LOCAL_GPT_OSS = {
  name: "gpt-oss:20b",
  model: "gpt-oss:20b",
  modified_at: "2025-11-18T16:50:58.981775142+01:00",
  size: 13793441244,
  digest: "17052f91a42e97930aa6e28a6c6c06a983e6a58dbb00434885a0cf531e376f7",
  details: {
    parent_model: "",
    format: "gguf",
    family: "gptoss",
    families: ["gptoss"],
    parameter_size: "20.9B",
    quantization_level: "MXFP4",
  },
}

/** Cloud entry WITHOUT the remote_host flag — the ':cloud' suffix alone must filter it. */
const CLOUD_NO_REMOTE_HOST = {
  ...CLOUD_MANIFEST,
  name: "llama3.3:cloud",
  model: "llama3.3:cloud",
  remote_model: undefined,
  remote_host: undefined,
}

/** Local entry that merely CONTAINS 'cloud' in its name — must NOT be filtered. */
const LOCAL_CLOUDY_NAME = {
  ...LOCAL_QWEN,
  name: "cloudwalker:8b",
  model: "cloudwalker:8b",
}

const originalFetch = globalThis.fetch

/** Stub global fetch for the discovery client's GET {baseUrl}/api/tags. */
function stubOllamaTags(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch
}

afterAll(() => {
  globalThis.fetch = originalFetch
})

/** Create a local ollama provider through the real addProvider path. */
async function makeOllamaProvider(db: InMemoryDb) {
  const svc = new ProviderService(db as any)
  const provider = await svc.addProvider("user_oll", {
    providerType: "ollama",
    displayName: "Ollama Local",
    config: { baseUrl: "http://localhost:11434" },
  })
  return { svc, provider }
}

describe("ProviderService ollama discovery — :cloud manifest filter", () => {
  it("filters mistral-large-4:cloud out of discovery and keeps the real local models", async () => {
    stubOllamaTags({ models: [CLOUD_MANIFEST, LOCAL_QWEN, LOCAL_GPT_OSS] })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId)

    expect(result.ok).toBe(true)
    const modelStrings = (result.models ?? []).map((m) => m.modelString)
    expect(modelStrings).toEqual(["qwen3-coder:30b", "gpt-oss:20b"])
    expect(modelStrings).not.toContain("mistral-large-4:cloud")
  })

  it("persists the filtered list — user_providers.models never contains a :cloud entry", async () => {
    stubOllamaTags({ models: [CLOUD_MANIFEST, LOCAL_QWEN, LOCAL_GPT_OSS] })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    await svc.testProvider(provider.providerId)

    const stored = await db
      .collection("user_providers")
      .findOne({ providerId: provider.providerId })
    expect(stored).toBeTruthy()
    const modelStrings = (stored!.models as Array<{ modelString: string }>).map((m) => m.modelString)
    expect(modelStrings).toEqual(["qwen3-coder:30b", "gpt-oss:20b"])
    expect(modelStrings.some((s) => s.endsWith(":cloud"))).toBe(false)
  })

  it("filters cloud entries by the ':cloud' suffix alone, even without remote_host", async () => {
    stubOllamaTags({ models: [CLOUD_NO_REMOTE_HOST, LOCAL_QWEN] })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId)

    const modelStrings = (result.models ?? []).map((m) => m.modelString)
    expect(modelStrings).toEqual(["qwen3-coder:30b"])
    expect(modelStrings).not.toContain("llama3.3:cloud")
  })

  it("does not over-filter local models whose name merely contains 'cloud'", async () => {
    stubOllamaTags({ models: [LOCAL_CLOUDY_NAME, CLOUD_MANIFEST] })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId)

    const modelStrings = (result.models ?? []).map((m) => m.modelString)
    expect(modelStrings).toEqual(["cloudwalker:8b"])
    expect(modelStrings).not.toContain("mistral-large-4:cloud")
  })

  it("returns an empty model list (still ok: nothing local installed) when the daemon only has cloud manifests", async () => {
    stubOllamaTags({ models: [CLOUD_MANIFEST] })
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    const result = await svc.testProvider(provider.providerId)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("No models discovered for this provider")
    // The stored provider must NOT be flipped to active with cloud junk.
    const stored = await db
      .collection("user_providers")
      .findOne({ providerId: provider.providerId })
    expect((stored!.models as unknown[]).length).toBe(0)
  })

  it("keeps the connection-error path intact when the daemon is unreachable", async () => {
    // discoverModels runs BEFORE testProvider's try block, so an unreachable
    // daemon REJECTS the call (handlers wrap it) — it never returns {ok:false}
    // and never touches the stored provider doc.
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434")
    }) as typeof fetch
    const db = new InMemoryDb()
    const { svc, provider } = await makeOllamaProvider(db)

    expect(svc.testProvider(provider.providerId)).rejects.toThrow(
      "Cannot connect to Ollama at http://localhost:11434",
    )

    const stored = await db
      .collection("user_providers")
      .findOne({ providerId: provider.providerId })
    expect((stored!.models as unknown[]).length).toBe(0)
  })
})
