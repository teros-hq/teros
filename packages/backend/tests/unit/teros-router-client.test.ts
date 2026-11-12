/**
 * Tests for TerosRouterClient (TPROV-REQ-7/8/9): size overrides, vision
 * rerouting, adapter caching and the model string handed to the adapter.
 *
 * @spec TPROV-REQ-7, TPROV-REQ-8, TPROV-REQ-9
 */

import { describe, expect, it } from "bun:test"
import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core"
import type { RetentionTier } from "@teros/shared"
import { DEFAULT_TEROS_SIZES, sameRouteOnBothLanes as both, type TerosSizesConfig } from "../../src/models/providers/teros"
import { requestHasImages, TerosRouterClient, TerosUpstreamUnavailableError } from "../../src/services/teros-router-client"
import type { ResolvedTerosRoute, TerosSecrets } from "../../src/services/teros-upstream"

const secrets: TerosSecrets = {
  system: ((name: string) => ({ fireworks: { apiKey: "fw" }, helmcode: { apiKey: "hc" } } as Record<string, any>)[name]) as TerosSecrets["system"],
}
const zdr = () => ({ tier: "zdr" as RetentionTier })

const HELMCODE: TerosSizesConfig = {
  sizes: {
    l: both({ upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" }),
    m: both({ upstream: "helmcode", modelString: "glm5.3-flash", reasoningEffort: "medium" }),
    s: both({ upstream: "helmcode", modelString: "deepseek-v4-flash", reasoningEffort: "none" }),
  },
  failover: { mode: "off", upstream: "fireworks" },
}

const textOnly: StreamMessageOptions["messages"] = [
  { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] } as any,
]
const withImage: StreamMessageOptions["messages"] = [
  { info: { role: "user" }, parts: [{ type: "text", text: "look" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }] } as any,
]
const withToolImage: StreamMessageOptions["messages"] = [
  { info: { role: "assistant" }, parts: [{ type: "tool", state: { status: "completed", attachments: [{ mime: "image/jpeg", url: "x" }] } }] } as any,
]

/** Records every adapter build and every call: which model string each request used. */
function harness(size: "l" | "m" | "s", config: TerosSizesConfig) {
  const builds: string[] = []
  const calls: Array<{ adapter: string; model: string | undefined }> = []
  const client = new TerosRouterClient({
    size,
    config,
    secrets,
    retentionResolver: zdr,
    buildAdapter: async (route: ResolvedTerosRoute) => {
      const tag = `${route.upstream}:${route.modelString}:${route.reasoningEffort}`
      builds.push(tag)
      const adapter: ILLMClient = {
        async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
          calls.push({ adapter: tag, model: options.model })
          return { stopReason: "end_turn", metadata: { model: options.model } } as LLMResponse
        },
        getProviderInfo: () => ({ name: tag, model: route.modelString, capabilities: { streaming: true, tools: true, thinking: true, vision: route.vision } }),
      }
      return adapter
    },
  })
  return { client, builds, calls }
}

describe("[TPROV-AC-4] requestHasImages", () => {
  it("[TPROV-AC-4] detects a user image part and a tool result with image attachments; text is false", () => {
    expect(requestHasImages(textOnly)).toBe(false)
    expect(requestHasImages(withImage)).toBe(true)
    expect(requestHasImages(withToolImage)).toBe(true)
  })
})

describe("[TPROV-AC-4] vision routing", () => {
  it("[TPROV-AC-4] L on Fireworks (no vision) + image → GLM-5.3 Flash on Fireworks; text → GLM-5.3", async () => {
    const h = harness("l", DEFAULT_TEROS_SIZES)
    await h.client.streamMessage({ messages: textOnly, lane: "interactive" })
    await h.client.streamMessage({ messages: withImage, lane: "interactive" })
    expect(h.calls.map((c) => c.model)).toEqual([
      "accounts/fireworks/models/glm-5p3",
      "accounts/fireworks/models/glm-5p3-flash",
    ])
    expect(h.calls[1]!.adapter).toContain("glm-5p3-flash")
  })
  it("[TPROV-AC-4] L on Helmcode (vision) + image → stays on glm5.3", async () => {
    const h = harness("l", HELMCODE)
    await h.client.streamMessage({ messages: withImage, lane: "interactive" })
    expect(h.calls[0]).toEqual({ adapter: "helmcode:glm5.3:high", model: "glm5.3" })
  })
})

describe("[TPROV-AC-5] size overrides", () => {
  it("[TPROV-AC-5] model: 'teros-s' on an L client runs S's route; an unknown override is forwarded untouched", async () => {
    const h = harness("l", HELMCODE)
    await h.client.streamMessage({ messages: textOnly, lane: "interactive", model: "teros-s" })
    await h.client.streamMessage({ messages: textOnly, lane: "interactive" })
    expect(h.calls.map((c) => c.adapter)).toEqual(["helmcode:deepseek-v4-flash:none", "helmcode:glm5.3:high"])
    expect(h.calls.map((c) => c.model)).toEqual(["deepseek-v4-flash", "glm5.3"])
  })
})

describe("[TPROV-NFR-1] adapters are built once per route", () => {
  it("[TPROV-NFR-1] three requests on two routes build two adapters", async () => {
    const h = harness("l", DEFAULT_TEROS_SIZES)
    await h.client.streamMessage({ messages: textOnly, lane: "interactive" })
    await h.client.streamMessage({ messages: textOnly, lane: "interactive" })
    await h.client.streamMessage({ messages: withImage, lane: "interactive" })
    expect(h.builds).toHaveLength(2)
  })
})

describe("[TPROV-AC-2] unavailable upstream", () => {
  it("[TPROV-AC-2] a size whose secret is missing throws TEROS_UPSTREAM_UNAVAILABLE naming the upstream", async () => {
    const onTogether: TerosSizesConfig = { ...HELMCODE, sizes: { ...HELMCODE.sizes, l: both({ upstream: "together", modelString: "zai-org/GLM-5.3", reasoningEffort: "high" }) } }
    const h = harness("l", onTogether)
    let err: unknown
    try {
      await h.client.streamMessage({ messages: textOnly, lane: "interactive" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TerosUpstreamUnavailableError)
    expect((err as TerosUpstreamUnavailableError).upstream).toBe("together")
    expect(h.client.getProviderInfo().name).toBe("teros")
  })
})
