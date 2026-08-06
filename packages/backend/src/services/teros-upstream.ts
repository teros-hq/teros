/**
 * `resolveTerosUpstream` — single source of truth for where a `teros` turn runs
 * (TER-617 / F3).
 *
 * The decision "teros = Fireworks" used to be triplicated (baseUrl in the
 * factory, apiKey in `llm-client-manager`, apiKey again in `provider-service`).
 * This resolver unifies it and adds the second upstream (Together) for failover.
 * The fallback must swap `baseUrl` + `apiKey` + `modelString` together — the
 * same logical model has a different provider model string per upstream.
 *
 * Returns `null` when the upstream cannot serve the request, which is how the
 * caller decides "no failover available":
 *   - the model has no equivalent on that upstream (Kimi K2.7 Code on Together);
 *   - the system secret is missing;
 *   - **ZDR guard (C2)**: `together` is only allowed when retention tier is
 *     `zdr`. Today Together is classified `retains` (its account-level ZDR is a
 *     toggle not verifiable by API), so this keeps the fallback INERT and
 *     ZDR-safe by construction until that toggle is asserted + reclassified in
 *     `data-retention.ts`. Routing outside ZDR is impossible by construction.
 *
 * A lint-as-test (`teros-fallback-invariant.test.ts`) pins that nothing reads
 * `secrets.system('fireworks')` or the Fireworks baseURL outside this module.
 */

import { type RetentionTier, resolveRetention } from "@teros/shared"
import { TEROS_UPSTREAM_MODELS, type TerosUpstream } from "../models/providers/teros.js"
import type { SecretsManager } from "../secrets/secrets-manager.js"

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"
export const TOGETHER_BASE_URL = "https://api.together.ai/v1"

export interface ResolvedTerosUpstream {
  upstream: TerosUpstream
  baseUrl: string
  apiKey: string
  /** Provider model string for THIS upstream (differs per upstream). */
  modelString: string
  /** Telemetry dimension (= upstream); flows to `llm_usage.actualProvider` (F1). */
  actualProvider: TerosUpstream
}

/** Minimal retention shape — injected for testability (default: real resolver). */
type RetentionResolver = (provider: string) => { tier: RetentionTier }

/**
 * Resolve the connection details for running `model` on `upstream`.
 * `null` ⇒ that upstream cannot serve it (missing secret, no Together equivalent,
 * or ZDR guard). The PRIMARY Fireworks path never returns null for an unknown
 * modelId — see R2 below.
 *
 * @param model `{ modelId, modelString }` from the catalogue. The `modelString`
 *   is the Fireworks default; the failover map only OVERRIDES it per upstream.
 * @param retentionResolver injected for tests; defaults to the shared classifier.
 */
export function resolveTerosUpstream(
  upstream: TerosUpstream,
  model: { modelId: string; modelString: string },
  secrets: Pick<SecretsManager, "system">,
  retentionResolver: RetentionResolver = resolveRetention,
): ResolvedTerosUpstream | null {
  const mapped = TEROS_UPSTREAM_MODELS[model.modelId]

  if (upstream === "fireworks") {
    const apiKey = secrets.system("fireworks")?.apiKey
    if (!apiKey) return null
    return {
      upstream,
      baseUrl: FIREWORKS_BASE_URL,
      apiKey,
      // R2/M1: the PRIMARY Fireworks path must NOT depend on the failover map.
      // A teros model absent from TEROS_UPSTREAM_MODELS still runs on Fireworks
      // with its catalogue modelString — the map only refines the failover. (A
      // missing map entry is caught by a lint-as-test so failover stays available.)
      modelString: mapped?.fireworks ?? model.modelString,
      actualProvider: "fireworks",
    }
  }

  // upstream === "together": ZDR guard FIRST — never route to a non-ZDR upstream.
  if (retentionResolver("together").tier !== "zdr") return null
  // Failover DOES depend on the map: an unmapped model (or `together: null`) has
  // no Together equivalent → no failover (stays Fireworks-only).
  const modelString = mapped?.together
  if (!modelString) return null
  const apiKey = secrets.system("together")?.apiKey
  if (!apiKey) return null
  return {
    upstream,
    baseUrl: TOGETHER_BASE_URL,
    apiKey,
    modelString,
    actualProvider: "together",
  }
}
