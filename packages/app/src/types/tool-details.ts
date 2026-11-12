/**
 * Static tool metadata as returned by the `app.get-tool-details` WS action.
 *
 * One declaration, imported by everything that touches the shape: the typed
 * domain API (`services/AppApi.ts`), the session cache
 * (`components/mca/tool-details-cache.ts`), the ranking helpers
 * (`components/mca/primitives/param-relevance.ts`) and the approval-card
 * primitives. It previously existed as four near-copies — two full 8-field
 * duplicates plus two hand-written subsets — which drift silently because the
 * subsets are structurally assignable to the whole.
 *
 * Lives under `types/` rather than beside either consumer for two reasons:
 * `services/` must not depend on `components/`, and the cache module has to stay
 * importable by `bun test` (no react-native, no transport). This file imports
 * nothing, so it satisfies both.
 *
 * NOTE: per ARCHITECTURE.md the WS *response* shape belongs in `@teros/shared`
 * alongside the rest of the protocol, and the handler should validate its return
 * against it. That promotion is a follow-up; this module is the app-side single
 * source until then. The annotations, however, already have a canonical home and
 * are taken from it below rather than restated.
 */

import type { McaToolAnnotations } from "@teros/shared"

/**
 * JSON Schema for a tool's parameters.
 *
 * Named `ToolParameters` and not `ToolInputSchema` to match
 * `ToolDefinitionSchema.parameters` in `@agentapps/protocol`, which is the
 * contract this metadata will arrive under once MCA transport moves to the
 * session plane. `StaticToolDefinition.inputSchema` on the backend keeps its
 * own name — that one describes `tools.json` on disk, which is a different
 * thing that happens to hold the same value.
 */
export interface ToolParameters {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
}

/**
 * Exactly what the backend sends: `get-tool-details` forwards
 * `StaticToolDefinition.annotations` (mca-manager.types.ts:52), which IS
 * `McaToolAnnotations`, already validated against `McaToolAnnotationsSchema` at
 * manifest load.
 *
 * Aliased rather than re-declared. The hand-written copies this replaced listed
 * only 8 of the 12 fields, and because a narrower object type stays assignable to
 * a wider one, TypeScript reported nothing — the app simply could not see
 * `stability`, `version` or `deprecationMessage` on a payload that carries them.
 */
export type ToolAnnotations = McaToolAnnotations

export interface ToolDetail {
  /** The name the client asked for — possibly namespaced (`${appName}_${short}`). */
  requestedName: string
  /** The bare tool name as declared in tools.json. */
  name: string
  description: string
  parameters: ToolParameters
  annotations?: ToolAnnotations
}

export interface ToolDetailsResponse {
  appId: string
  mcaId: string
  /**
   * The app's display name (the catalog name, e.g. "HubSpot"). Optional until
   * every backend in the field sends it.
   *
   * @spec PERMW-REQ-4
   */
  appName?: string
  tools: ToolDetail[]
}
