/**
 * TerosRouterClient — the `ILLMClient` of a Teros SIZE (TPROV).
 *
 * Built for one size under one config, it decides the route of EVERY request:
 *   1. the size — the client's own, or the one a per-request `model` override
 *      names (`teros-l|m|s`: compaction, the voice fast leg, internal tasks run
 *      on S — TPROV-REQ-8);
 *   2. vision — a request carrying an image on a size whose upstream model
 *      cannot see is rerouted to the vision family on the same upstream
 *      (TPROV-REQ-7); a model that sees is never rerouted;
 *   3. the adapter — one OpenAI-compatible adapter per (upstream, model,
 *      effort), built lazily and cached for the life of the client (TPROV-NFR-1).
 *
 * The adapter is called with `model: route.modelString`, so `actualModel`
 * (TurnDriver reads the adapter's `metadata.model`) and `actualProvider` report
 * what really ran (TPROV-REQ-9). Failover is NOT here: `TerosFallbackClient`
 * wraps two routers (primary upstream / failover upstream) — same semantics as
 * before, now configured per config instead of a flag (TPROV-REQ-6).
 *
 * The lane (TLANE) comes with each request (`options.lane`), never with the
 * client: the cache key and the worker key do not change when the lane does.
 *
 * @spec TPROV-REQ-7, TPROV-REQ-8, TPROV-REQ-9, TLANE-REQ-8
 */

import { type ILLMClient, LLMClientFactory, type LLMResponse, type StreamMessageOptions } from "@teros/core"
import { sizeOfModelId, type TerosLane, type TerosSize, type TerosSizesConfig } from "../models/providers/teros.js"
import {
  type ResolvedTerosRoute,
  resolveTerosRoute,
  resolveTerosVisionRoute,
  type RetentionResolver,
  type TerosSecrets,
} from "./teros-upstream.js"

export class TerosUpstreamUnavailableError extends Error {
  readonly code = "TEROS_UPSTREAM_UNAVAILABLE"
  constructor(
    readonly size: TerosSize,
    readonly upstream: string,
  ) {
    super(
      `Teros size ${size.toUpperCase()} cannot run on upstream '${upstream}': missing system secret, unknown model or non-ZDR upstream`,
    )
  }
}

type Messages = StreamMessageOptions["messages"]

/**
 * Whether the messages sent to the model carry an image: a user `file` part
 * with an `image/*` mime, or a completed tool result with image attachments
 * (the same two shapes the OpenAI-compatible adapter turns into `image_url`).
 * @spec TPROV-REQ-7
 */
export function requestHasImages(messages: Messages): boolean {
  for (const message of messages) {
    for (const part of (message as { parts?: any[] }).parts ?? []) {
      if (part?.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/")) return true
      if (part?.type === "tool") {
        const attachments = part.state?.attachments as Array<{ mime?: string }> | undefined
        if (attachments?.some((a) => typeof a?.mime === "string" && a.mime.startsWith("image/"))) return true
      }
    }
  }
  return false
}

export interface TerosRouterOptions {
  size: TerosSize
  config: TerosSizesConfig
  secrets: TerosSecrets
  /** Default max output tokens handed to the adapters. */
  maxTokens?: number
  /** Which upstream this router serves: the size's own (`primary`) or the config's failover (`failover`). */
  leg?: "primary" | "failover"
  retentionResolver?: RetentionResolver
  /** Adapter factory — injectable for tests; defaults to the core factory's `teros` case. */
  buildAdapter?: (route: ResolvedTerosRoute, maxTokens?: number) => Promise<ILLMClient>
  /** Override of the per-size resolution (failover routers resolve on the failover upstream). */
  resolveRoute?: (size: TerosSize, lane: TerosLane) => ResolvedTerosRoute | null
}

export class TerosRouterClient implements ILLMClient {
  private readonly adapters = new Map<string, Promise<ILLMClient>>()

  constructor(private readonly opts: TerosRouterOptions) {}

  /** The size's own route on a lane (null when its upstream cannot serve). */
  primaryRoute(lane: TerosLane): ResolvedTerosRoute | null {
    return this.routeOfSize(this.opts.size, lane)
  }

  private routeOfSize(size: TerosSize, lane: TerosLane): ResolvedTerosRoute | null {
    if (this.opts.resolveRoute) return this.opts.resolveRoute(size, lane)
    return resolveTerosRoute({
      size,
      lane,
      config: this.opts.config,
      secrets: this.opts.secrets,
      retentionResolver: this.opts.retentionResolver,
    })
  }

  /**
   * The route a request takes. Pure given the options; exported for tests.
   * @spec TPROV-REQ-7, TPROV-REQ-8
   */
  routeFor(options: Pick<StreamMessageOptions, "messages" | "model" | "lane">): ResolvedTerosRoute | null {
    const size = sizeOfModelId(options.model) ?? this.opts.size
    // TLANE-REQ-1: every Teros request runs on exactly one lane, named by the caller.
    if (!options.lane) throw new Error("Teros request without a lane (TLANE-REQ-1)")
    const route = this.routeOfSize(size, options.lane)
    if (!route) return null
    if (!route.vision && requestHasImages(options.messages)) {
      return resolveTerosVisionRoute(route, this.opts.secrets, this.opts.retentionResolver) ?? route
    }
    return route
  }

  private adapter(route: ResolvedTerosRoute): Promise<ILLMClient> {
    const key = `${route.upstream}:${route.modelString}:${route.reasoningEffort}`
    let pending = this.adapters.get(key)
    if (!pending) {
      const build = this.opts.buildAdapter ?? defaultBuildAdapter
      pending = build(route, this.opts.maxTokens)
      this.adapters.set(key, pending)
      pending.catch(() => this.adapters.delete(key))
    }
    return pending
  }

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const route = this.routeFor(options)
    if (!route) {
      const size = sizeOfModelId(options.model) ?? this.opts.size
      throw new TerosUpstreamUnavailableError(size, this.opts.config.sizes[size]?.[options.lane!]?.upstream ?? "unknown")
    }
    const adapter = await this.adapter(route)
    // A size id is not an upstream model: the adapter gets the resolved string
    // (which also makes `metadata.model` → `actualModel` exact, TPROV-REQ-9).
    return adapter.streamMessage({ ...options, model: route.modelString })
  }

  /**
   * Lane-agnostic description (TLANE-REQ-8): the route depends on each
   * request's lane, so the info names the size, and `vision` holds only when
   * the model of every lane sees.
   */
  getProviderInfo() {
    const routes = (["interactive", "background"] as const).map((lane) => this.primaryRoute(lane))
    return {
      name: "teros",
      model: `teros-${this.opts.size}`,
      capabilities: { streaming: true, tools: true, thinking: true, vision: routes.every((r) => r?.vision === true) },
    }
  }
}

/**
 * Dispatches each request to the client of its lane (TLANE-REQ-7): every lane
 * has its own failover wrapper (its primary upstream and whether the failover
 * upstream offers its family differ per lane), all sharing the config's one
 * failover setting. Requests without a lane are refused (TLANE-REQ-1).
 * @spec TLANE-REQ-1, TLANE-REQ-7, TLANE-REQ-8
 */
export class TerosLaneClient implements ILLMClient {
  constructor(
    private readonly byLane: Record<TerosLane, ILLMClient>,
    private readonly info: ILLMClient,
  ) {}

  streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    if (!options.lane) throw new Error("Teros request without a lane (TLANE-REQ-1)")
    return this.byLane[options.lane].streamMessage(options)
  }

  getProviderInfo() {
    return this.info.getProviderInfo()
  }
}

/** The core factory's `teros` case: an OpenAI-compatible adapter bound to the route. */
async function defaultBuildAdapter(route: ResolvedTerosRoute, maxTokens?: number): Promise<ILLMClient> {
  return LLMClientFactory.create({
    provider: "teros",
    teros: {
      apiKey: route.apiKey,
      model: route.modelString,
      maxTokens,
      baseUrl: route.baseUrl,
      actualProvider: route.actualProvider,
      reasoningEffort: route.reasoningEffort,
      vision: route.vision,
    },
  })
}
