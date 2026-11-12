/**
 * The Teros upstream resolver — single source of truth for where a `teros`
 * request runs (TER-617/F3, extended by TPROV).
 *
 * A user picks a SIZE (Model L / M / S). The Teros provider config that applies
 * to the user says, per size, which upstream (Helmcode / Fireworks / Together),
 * which upstream model and which reasoning effort serve it (TPROV-REQ-4). This
 * module turns that into connection details — base URL, system secret, model
 * string — and is the ONLY place that reads the `fireworks`, `together` and
 * `helmcode` system secrets or names their base URLs (TPROV-REQ-5; pinned by
 * `teros-fallback-invariant.test.ts`).
 *
 * Returns `null` when the upstream cannot serve the request:
 *   - the upstream's retention tier is not `zdr` (routing outside ZDR is
 *     impossible by construction);
 *   - the system secret is missing;
 *   - the model string is not in the upstream catalogue.
 * The caller decides what `null` means: the turn fails with a clear error, or
 * failover applies when the config arms it (TPROV-REQ-6). Never a silent
 * fallback to another upstream.
 *
 * Every size has one route per latency lane (TLANE-REQ-5): the caller names
 * the lane and gets that lane's route; failover and the vision reroute stay on
 * that lane (TLANE-REQ-7, TLANE-REQ-8). A lane never borrows the other's route.
 *
 * @spec TPROV-REQ-5, TPROV-REQ-6, TPROV-REQ-7, TLANE-REQ-7, TLANE-REQ-8
 */

import { type RetentionTier, resolveRetention } from "@teros/shared"
import {
  findTerosUpstreamModel,
  TEROS_UPSTREAMS,
  TEROS_VISION_FAMILY,
  terosUpstreamModelOfFamily,
  type TerosLane,
  type TerosModelFamily,
  type TerosReasoningEffort,
  type TerosSize,
  type TerosSizeRoute,
  type TerosSizesConfig,
  type TerosUpstream,
} from "../models/providers/teros.js"
import type { SecretsManager } from "../secrets/secrets-manager.js"

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"
export const TOGETHER_BASE_URL = "https://api.together.ai/v1"
export const HELMCODE_BASE_URL = "https://api.helmcode.com/v1"

const BASE_URL: Record<TerosUpstream, string> = {
  fireworks: FIREWORKS_BASE_URL,
  together: TOGETHER_BASE_URL,
  helmcode: HELMCODE_BASE_URL,
}

/** @spec TPROV-REQ-5 */
export interface ResolvedTerosRoute {
  size: TerosSize
  /** The lane whose route this is (TLANE-REQ-8, recorded per TLANE-REQ-9). */
  lane: TerosLane
  upstream: TerosUpstream
  baseUrl: string
  apiKey: string
  /** Provider model string for THIS upstream. */
  modelString: string
  reasoningEffort: TerosReasoningEffort
  family: TerosModelFamily
  /** Whether the upstream model accepts images (drives TPROV-REQ-7). */
  vision: boolean
  /** Telemetry dimension (= upstream); flows to `llm_usage.actualProvider`. */
  actualProvider: TerosUpstream
}

/** Minimal retention shape — injected for testability (default: real resolver). */
export type RetentionResolver = (provider: string) => { tier: RetentionTier }

export type TerosSecrets = Pick<SecretsManager, "system">

export interface ResolveTerosRouteInput {
  size: TerosSize
  /** @spec TLANE-REQ-8 */
  lane: TerosLane
  config: TerosSizesConfig
  secrets: TerosSecrets
  retentionResolver?: RetentionResolver
}

/** The system secret of an upstream — the one read site of those secrets (TPROV-REQ-5). */
function upstreamApiKey(upstream: TerosUpstream, secrets: TerosSecrets): string | undefined {
  switch (upstream) {
    case "fireworks":
      return secrets.system("fireworks")?.apiKey
    case "together":
      return secrets.system("together")?.apiKey
    case "helmcode":
      return secrets.system("helmcode")?.apiKey
  }
}

/**
 * Resolve a concrete route on an upstream: ZDR guard first, then catalogue,
 * then secret. Pure apart from the secret read.
 * @spec TPROV-REQ-5
 */
export function resolveTerosRouteOn(
  size: TerosSize,
  lane: TerosLane,
  route: TerosSizeRoute,
  secrets: TerosSecrets,
  retentionResolver: RetentionResolver = resolveRetention,
): ResolvedTerosRoute | null {
  if (retentionResolver(route.upstream).tier !== "zdr") return null
  const model = findTerosUpstreamModel(route.upstream, route.modelString)
  if (!model) return null
  const apiKey = upstreamApiKey(route.upstream, secrets)
  if (!apiKey) return null
  // An effort the model rejects would 400 upstream: clamp to the nearest it accepts.
  const reasoningEffort = model.efforts.includes(route.reasoningEffort)
    ? route.reasoningEffort
    : (model.efforts[0] ?? "low")
  return {
    size,
    lane,
    upstream: route.upstream,
    baseUrl: BASE_URL[route.upstream],
    apiKey,
    modelString: model.modelString,
    reasoningEffort,
    family: model.family,
    vision: model.vision,
    actualProvider: route.upstream,
  }
}

/** The primary route of a size on a lane under a config. @spec TPROV-REQ-5, TLANE-REQ-8 */
export function resolveTerosRoute(input: ResolveTerosRouteInput): ResolvedTerosRoute | null {
  const route = input.config.sizes[input.size]?.[input.lane]
  if (!route) return null
  return resolveTerosRouteOn(input.size, input.lane, route, input.secrets, input.retentionResolver)
}

/**
 * The failover route of a size on a lane: the same family as that lane's
 * route, on the config's single failover upstream, same effort. `null` when
 * failover is off, the family does not exist there, or that upstream cannot
 * serve (secret / ZDR).
 * @spec TPROV-REQ-6, TLANE-REQ-7
 */
export function resolveTerosFailoverRoute(input: ResolveTerosRouteInput): ResolvedTerosRoute | null {
  const { failover } = input.config
  if (failover.mode === "off") return null
  const primary = input.config.sizes[input.size]?.[input.lane]
  if (!primary || failover.upstream === primary.upstream) return null
  const primaryModel = findTerosUpstreamModel(primary.upstream, primary.modelString)
  if (!primaryModel) return null
  const equivalent = terosUpstreamModelOfFamily(failover.upstream, primaryModel.family)
  if (!equivalent) return null
  return resolveTerosRouteOn(
    input.size,
    input.lane,
    { upstream: failover.upstream, modelString: equivalent.modelString, reasoningEffort: primary.reasoningEffort },
    input.secrets,
    input.retentionResolver,
  )
}

/**
 * The route a request with images takes when `primary` cannot see: the vision
 * family on the SAME upstream. `null` when the upstream has none (the request
 * then proceeds on `primary`, nothing hidden).
 * @spec TPROV-REQ-7
 */
export function resolveTerosVisionRoute(
  primary: ResolvedTerosRoute,
  secrets: TerosSecrets,
  retentionResolver: RetentionResolver = resolveRetention,
): ResolvedTerosRoute | null {
  if (primary.vision) return primary
  const visionModel = terosUpstreamModelOfFamily(primary.upstream, TEROS_VISION_FAMILY)
  if (!visionModel) return null
  return resolveTerosRouteOn(
    primary.size,
    primary.lane,
    { upstream: primary.upstream, modelString: visionModel.modelString, reasoningEffort: primary.reasoningEffort },
    secrets,
    retentionResolver,
  )
}

/** What the admin window shows per upstream: secret present + retention tier (TPROV-REQ-10). */
export function terosUpstreamStatus(
  secrets: TerosSecrets,
  retentionResolver: RetentionResolver = resolveRetention,
): Array<{ upstream: TerosUpstream; baseUrl: string; hasSecret: boolean; retention: RetentionTier }> {
  return TEROS_UPSTREAMS.map((upstream) => ({
    upstream,
    baseUrl: BASE_URL[upstream],
    hasSecret: !!upstreamApiKey(upstream, secrets),
    retention: retentionResolver(upstream).tier,
  }))
}
