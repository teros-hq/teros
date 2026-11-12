/**
 * Teros latency lanes (TLANE): every size has an interactive and a background
 * route; each request runs on the lane its caller names.
 *
 * Pinned here:
 *  - the lane of a turn comes from its trigger, not from the channel;
 *  - one router serves both lanes (no client per lane, no cache-key change);
 *  - vision reroute and failover stay on the request's lane;
 *  - internal calls are background unless the call site declares interactive;
 *  - a config missing a lane is rejected naming the field.
 *
 * @spec TLANE-REQ-2, TLANE-REQ-4, TLANE-REQ-9, TLANE-REQ-7, TLANE-REQ-8, TLANE-REQ-11
 */

import { describe, expect, it } from "bun:test"
import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core"
import type { RetentionTier } from "@teros/shared"
import {
  sameRouteOnBothLanes,
  type TerosSizesConfig,
  validateTerosSizesConfig,
} from "../../src/models/providers/teros"
import { laneForTrigger } from "../../src/services/teros-lane"
import { TerosFallbackClient } from "../../src/services/teros-fallback-client"
import { TerosLaneClient, TerosRouterClient } from "../../src/services/teros-router-client"
import {
  resolveTerosFailoverRoute,
  resolveTerosRoute,
  type ResolvedTerosRoute,
  type TerosSecrets,
} from "../../src/services/teros-upstream"
import { TranscriptCleaner } from "../../src/services/transcription/transcript-cleaner"
import { InternalLLMService } from "../../src/services/internal-llm-service"
import { AgentUsageSessionService } from "../../src/services/agent-usage-session-service"

const secrets: TerosSecrets = {
  system: ((name: string) =>
    ({ fireworks: { apiKey: "fw" }, together: { apiKey: "tg" }, helmcode: { apiKey: "hc" } })[name]) as TerosSecrets["system"],
}
const zdr = () => ({ tier: "zdr" as RetentionTier })

/** L: Fireworks GLM-5.3 when someone waits, Helmcode GLM 5.3 when nobody does. */
const LANES: TerosSizesConfig = {
  sizes: {
    l: {
      interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "high" },
      background: { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" },
    },
    m: sameRouteOnBothLanes({ upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3-flash", reasoningEffort: "medium" }),
    s: {
      interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/deepseek-v4p1-flash", reasoningEffort: "none" },
      background: { upstream: "helmcode", modelString: "deepseek-v4-flash", reasoningEffort: "none" },
    },
  },
  failover: { mode: "off", upstream: "together" },
}

const text: StreamMessageOptions["messages"] = [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] } as any]
const image: StreamMessageOptions["messages"] = [
  { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }] } as any,
]

function router(config: TerosSizesConfig, size: "l" | "m" | "s" = "l") {
  const calls: Array<{ lane?: string; upstream: string; model?: string }> = []
  const client = new TerosRouterClient({
    size,
    config,
    secrets,
    retentionResolver: zdr,
    buildAdapter: async (route: ResolvedTerosRoute): Promise<ILLMClient> => ({
      async streamMessage(o: StreamMessageOptions): Promise<LLMResponse> {
        calls.push({ lane: o.lane, upstream: route.upstream, model: o.model })
        return { stopReason: "end_turn", metadata: { model: o.model } } as LLMResponse
      },
      getProviderInfo: () => ({ name: route.upstream, model: route.modelString, capabilities: { streaming: true, tools: true, thinking: true, vision: route.vision } }),
    }),
  })
  return { client, calls }
}

describe("[TLANE-AC-2] the lane of a turn picks the route", () => {
  it("[TLANE-AC-2] user_message → interactive; scheduled, autorun, event_subscription → background", () => {
    expect(laneForTrigger("user_message")).toBe("interactive")
    expect(laneForTrigger("scheduled")).toBe("background")
    expect(laneForTrigger("autorun")).toBe("background")
    expect(laneForTrigger("event_subscription")).toBe("background")
    expect(laneForTrigger("delegation")).toBe("interactive")
  })
  it("[TLANE-AC-2] L interactive runs on Fireworks glm-5p3, L background on Helmcode glm5.3", async () => {
    const h = router(LANES)
    await h.client.streamMessage({ messages: text, lane: "interactive" })
    await h.client.streamMessage({ messages: text, lane: "background" })
    expect(h.calls).toEqual([
      { lane: "interactive", upstream: "fireworks", model: "accounts/fireworks/models/glm-5p3" },
      { lane: "background", upstream: "helmcode", model: "glm5.3" },
    ])
    expect(resolveTerosRoute({ size: "l", lane: "background", config: LANES, secrets, retentionResolver: zdr })?.lane).toBe("background")
  })
  it("[TLANE-AC-2] a request without a lane is refused (TLANE-REQ-1)", async () => {
    const h = router(LANES)
    await expect(h.client.streamMessage({ messages: text })).rejects.toThrow("without a lane")
  })
})

describe("[TLANE-AC-3] a headless channel is not a lane signal", () => {
  it("[TLANE-AC-3] the lane depends on the trigger only: a user message on a G2 headless channel is interactive", () => {
    // laneForTrigger takes no channel at all: G2 / Even Terminal turns arrive as
    // user_message and run interactive although their channels are headless.
    expect(laneForTrigger.length).toBe(1)
    expect(laneForTrigger("user_message")).toBe("interactive")
  })
})

describe("[TLANE-AC-4] one client serves both lanes", () => {
  it("[TLANE-AC-4] a scheduled then a user request on the same client use the two routes in order", async () => {
    const h = router(LANES)
    await h.client.streamMessage({ messages: text, lane: "background" })
    await h.client.streamMessage({ messages: text, lane: "interactive" })
    expect(h.calls.map((c) => c.upstream)).toEqual(["helmcode", "fireworks"])
  })
})

describe("[TLANE-AC-5] size overrides stay on the turn's lane", () => {
  it("[TLANE-AC-5] model teros-s during a background turn runs S's background route", async () => {
    const h = router(LANES)
    await h.client.streamMessage({ messages: text, lane: "background", model: "teros-s" })
    await h.client.streamMessage({ messages: text, lane: "interactive", model: "teros-s" })
    expect(h.calls.map((c) => c.model)).toEqual(["deepseek-v4-flash", "accounts/fireworks/models/deepseek-v4p1-flash"])
  })
})

describe("[TLANE-AC-6] vision reroute on the lane's upstream", () => {
  it("[TLANE-AC-6] a background image request on a model without vision reroutes on the background upstream", async () => {
    const blind: TerosSizesConfig = {
      ...LANES,
      sizes: {
        ...LANES.sizes,
        l: {
          interactive: { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" },
          background: { upstream: "together", modelString: "zai-org/GLM-5.3", reasoningEffort: "high" },
        },
      },
    }
    const h = router(blind)
    await h.client.streamMessage({ messages: image, lane: "background" })
    expect(h.calls[0]).toEqual({ lane: "background", upstream: "together", model: "zai-org/GLM-5.3-Flash" })
  })
})

describe("[TLANE-AC-7] the shared failover applies per lane", () => {
  it("[TLANE-AC-7] background failover is the background route's family on the failover upstream", () => {
    const onError: TerosSizesConfig = { ...LANES, failover: { mode: "on-error", upstream: "together" } }
    expect(resolveTerosFailoverRoute({ size: "l", lane: "background", config: onError, secrets, retentionResolver: zdr })).toMatchObject({
      lane: "background",
      upstream: "together",
      modelString: "zai-org/GLM-5.3",
    })
  })
  it("[TLANE-AC-7] a transient error before output on a background request retries once on the failover leg", async () => {
    const seen: string[] = []
    const failing: ILLMClient = {
      async streamMessage(o) {
        seen.push(`primary:${o.lane}`)
        throw Object.assign(new Error("503"), { context: { errorClass: "server_error" } })
      },
      getProviderInfo: () => ({ name: "p", model: "p", capabilities: { streaming: true, tools: true, thinking: true, vision: false } }),
    }
    const failover: ILLMClient = {
      async streamMessage(o) {
        seen.push(`failover:${o.lane}`)
        return { stopReason: "end_turn" } as LLMResponse
      },
      getProviderInfo: () => ({ name: "f", model: "f", capabilities: { streaming: true, tools: true, thinking: true, vision: false } }),
    }
    const client = new TerosLaneClient(
      {
        interactive: failing,
        background: new TerosFallbackClient(failing, failover, "on-error", { primary: "helmcode", secondary: "together" }),
      },
      failing,
    )
    await client.streamMessage({ messages: text, lane: "background" })
    expect(seen).toEqual(["primary:background", "failover:background"])
  })
})

describe("[TLANE-AC-8] internal calls", () => {
  it("[TLANE-AC-8] the transcript cleaner asks for the interactive lane", async () => {
    let lane: string | undefined
    const cleaner = new TranscriptCleaner({
      internalLLM: {
        generateText: async (_p: string, o?: { lane?: string }) => {
          lane = o?.lane
          return "hola que tal"
        },
      } as any,
    })
    await cleaner.clean("eh, hola que tal", "llm")
    expect(lane).toBe("interactive")
  })
  it("[TLANE-AC-8] InternalLLMService runs on background unless the call site says interactive", async () => {
    const lanes: Array<string | undefined> = []
    const svc = new InternalLLMService({} as any, {} as any)
    ;(svc as any).client = {
      async streamMessage(o: StreamMessageOptions) {
        lanes.push(o.lane)
        await o.callbacks?.onText?.("x")
        return { stopReason: "end_turn" }
      },
    }
    await svc.generateChannelName([{ role: "user", text: "hola" }])
    await svc.generateStructured("{}")
    await svc.generateText("p")
    await svc.generateText("p", { lane: "interactive" })
    expect(lanes).toEqual(["background", "background", "background", "interactive"])
  })
})

describe("[TLANE-AC-9] validation", () => {
  it("[TLANE-AC-9] a config without sizes.m.background is rejected naming the field", () => {
    const missing = { ...LANES, sizes: { ...LANES.sizes, m: { interactive: LANES.sizes.m.interactive } } }
    expect(validateTerosSizesConfig(missing)).toEqual({ ok: false, error: "sizes.m.background" })
    expect(validateTerosSizesConfig(LANES).ok).toBe(true)
  })
})

describe("[TLANE-AC-2] the usage session records the lane", () => {
  it("[TLANE-AC-2] session.started carries the lane of a Teros turn next to actualProvider", () => {
    const emitted: any[] = []
    const svc = new AgentUsageSessionService({ emit: (e: any) => emitted.push(e) } as any)
    svc.start({
      parentSessionUsageId: null,
      triggerKind: "scheduled",
      userId: "u",
      agentId: "a",
      workspaceId: "w",
      channelId: "c",
      provider: "teros" as any,
      modelId: "teros-l",
      actualProvider: "helmcode",
      actualModel: "glm5.3",
      lane: "background",
    })
    expect(emitted[0].payload).toMatchObject({ actualProvider: "helmcode", actualModel: "glm5.3", lane: "background" })
  })
})
