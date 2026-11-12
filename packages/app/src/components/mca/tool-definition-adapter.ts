/**
 * The source seam for approval-path tool metadata.
 *
 * Today `app.get-tool-details` reads `tools.json` through
 * `mcaManager.getStaticToolsForMca()`. Under `@agentapps/protocol` the same
 * metadata arrives as a `ToolDefinition` on a session-plane `tools_list` from a
 * controller-managed instance. The two differ in origin, not in shape — so this
 * module is the one place that changes when the source moves, and everything
 * downstream (`rankParams`, `resolveIntent`, `CapabilityBadges`) keeps reading
 * `ToolDetail`.
 *
 * Validation is loud, not lenient: a definition missing its parameter schema
 * would render an approval card with no parameters, which reads to the user as
 * "this call sends nothing" rather than as missing information. Principle 3.
 *
 * Pure by design — no React, no transport — so `bun test` can exercise it.
 */

import type { ToolAnnotations, ToolDetail, ToolParameters } from "../../types/tool-details"

/**
 * A tool definition in `@agentapps/protocol` shape (`ToolDefinitionSchema` in
 * `packages/protocol/src/tools.ts`). Declared here rather than imported because
 * Teros does not depend on that package yet; the field names are deliberately
 * identical so the import is a one-line swap when it does.
 */
export interface AgentAppsToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  annotations?: ToolAnnotations
}

export function toolDetailFromDefinition(
  requestedName: string,
  def: AgentAppsToolDefinition,
): ToolDetail {
  if (!requestedName) {
    throw new Error("toolDetailFromDefinition: requestedName is required")
  }
  if (!def?.name) {
    throw new Error(
      `toolDetailFromDefinition: definition.name is required (requestedName=${requestedName})`,
    )
  }
  const properties = def.parameters?.properties
  if (typeof properties !== "object" || properties === null) {
    throw new Error(
      `toolDetailFromDefinition: definition.parameters.properties is required (name=${def.name})`,
    )
  }

  return {
    requestedName,
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.annotations ? { annotations: def.annotations } : {}),
  }
}
