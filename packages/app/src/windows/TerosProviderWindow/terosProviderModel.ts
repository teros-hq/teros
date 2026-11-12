/**
 * Pure editing model of the Teros provider window (TPROV-REQ-10): keep a
 * draft of a config's routes valid against the upstream catalogue while the
 * admin changes upstream, model or effort, and know when there is something to
 * save. Every size has one route per lane (TLANE-REQ-5); each edit names the
 * lane it changes and leaves the other lane alone.
 *
 * @spec TPROV-REQ-10, TLANE-REQ-10
 */
import type {
  TerosFailoverSetting,
  TerosLane,
  TerosProviderConfig,
  TerosReasoningEffort,
  TerosSize,
  TerosSizeRoute,
  TerosSizeRoutes,
  TerosUpstream,
  TerosUpstreamInfo,
} from "../../services/AdminApi"

export const SIZES: TerosSize[] = ["l", "m", "s"]
export const LANES: TerosLane[] = ["interactive", "background"]
export const EFFORTS: TerosReasoningEffort[] = ["none", "low", "medium", "high"]

export interface Routing {
  sizes: Record<TerosSize, TerosSizeRoutes>
  failover: TerosFailoverSetting
}

export function routingOf(config: TerosProviderConfig): Routing {
  return { sizes: { ...config.sizes }, failover: { ...config.failover } }
}

/** Replace one lane's route of a size. */
function withRoute(routing: Routing, size: TerosSize, lane: TerosLane, route: TerosSizeRoute): Routing {
  return { ...routing, sizes: { ...routing.sizes, [size]: { ...routing.sizes[size], [lane]: route } } }
}

export function modelsOf(upstreams: TerosUpstreamInfo[], upstream: TerosUpstream) {
  return upstreams.find((u) => u.upstream === upstream)?.models ?? []
}

export function findModel(upstreams: TerosUpstreamInfo[], route: Pick<TerosSizeRoute, "upstream" | "modelString">) {
  return modelsOf(upstreams, route.upstream).find((m) => m.modelString === route.modelString)
}

/** The effort the model accepts closest to `wanted` (catalogue order: none < low < medium < high). */
export function nearestEffort(accepted: TerosReasoningEffort[], wanted: TerosReasoningEffort): TerosReasoningEffort {
  if (accepted.includes(wanted)) return wanted
  const i = EFFORTS.indexOf(wanted)
  const sorted = [...accepted].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - i) - Math.abs(EFFORTS.indexOf(b) - i))
  return sorted[0] ?? "low"
}

/**
 * Change the upstream of one lane of a size: keep the same family when the new
 * upstream offers it, else its first model; clamp the effort to what that
 * model accepts.
 */
export function withUpstream(
  routing: Routing,
  upstreams: TerosUpstreamInfo[],
  size: TerosSize,
  lane: TerosLane,
  upstream: TerosUpstream,
): Routing {
  const current = routing.sizes[size][lane]
  if (current.upstream === upstream) return routing
  const family = findModel(upstreams, current)?.family
  const models = modelsOf(upstreams, upstream)
  const next = (family ? models.find((m) => m.family === family) : undefined) ?? models[0]
  if (!next) return routing
  return withModel(routing, upstreams, size, lane, upstream, next.modelString)
}

/** Change the model of one lane of a size (same upstream); the effort is clamped. */
export function withModel(
  routing: Routing,
  upstreams: TerosUpstreamInfo[],
  size: TerosSize,
  lane: TerosLane,
  upstream: TerosUpstream,
  modelString: string,
): Routing {
  const model = findModel(upstreams, { upstream, modelString })
  if (!model) return routing
  const reasoningEffort = nearestEffort(model.efforts, routing.sizes[size][lane].reasoningEffort)
  return withRoute(routing, size, lane, { upstream, modelString, reasoningEffort })
}

export function withEffort(routing: Routing, size: TerosSize, lane: TerosLane, reasoningEffort: TerosReasoningEffort): Routing {
  return withRoute(routing, size, lane, { ...routing.sizes[size][lane], reasoningEffort })
}

export function withFailover(routing: Routing, failover: Partial<TerosFailoverSetting>): Routing {
  return { ...routing, failover: { ...routing.failover, ...failover } }
}

export function isDirty(a: Routing, b: Routing): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** Why a route cannot run today: a missing key or a non-ZDR upstream (TPROV-REQ-5). */
export function routeProblem(upstreams: TerosUpstreamInfo[], route: TerosSizeRoute): "no-key" | "not-zdr" | null {
  const u = upstreams.find((x) => x.upstream === route.upstream)
  if (!u) return null
  if (u.retention !== "zdr") return "not-zdr"
  if (!u.hasSecret) return "no-key"
  return null
}
