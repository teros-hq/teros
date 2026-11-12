/**
 * app.get-tool-details — Read description + parameters + annotations for the
 * named tools of ONE installed app.
 *
 * Feeds the permission-approval detail UI (docs/specs/mca/permission-approval-detail.md):
 * while a tool sits in `pending_permission`, the frontend needs the tool's own
 * description and JSON Schema to explain what is about to happen and which values
 * will be sent.
 *
 * WORKSPACE-SCOPED, NOT ADMIN-GATED — unlike the sibling `app.get-mca-tool-schemas`,
 * which accepts a raw catalog `mcaId` and can therefore enumerate schemas for MCAs
 * the caller never installed (a global-catalog surface, correctly locked behind
 * requireSystemAdmin by TER-447). This action cannot enumerate: it requires an
 * `appId` the caller already has workspace access to, derives `mcaId` from that app
 * record, and returns only the explicitly named tools of that one app. See the
 * "Relationship to TER-447" section of the spec.
 *
 * Access check mirrors `get-tools.ts` exactly: owner, `system` app, or workspace
 * member.
 */

import type { WsHandlerContext } from "@teros/shared"
import { assertAppVisible, assertAppManageable } from './app-visibility'
import { createLogger } from "../../../lib/logger"
import { humanizeToolDescription } from "../../../lib/mca-presentation"
import { captureException } from "../../../lib/sentry"
import type { McaManager } from "../../../services/mca-manager"
import type { StaticToolDefinition } from "../../../services/mca-manager.types"
import type { McaService } from "../../../services/mca-service"
import type { WorkspaceService } from "../../../services/workspace-service"
import { normalizeToolName } from "../../../types/permissions"
import { HandlerError } from "../../../ws-framework/WsRouter"

const log = createLogger("GetToolDetails")

/**
 * One tool's metadata on the wire.
 *
 * Field names follow `ToolDefinitionSchema` in `@agentapps/protocol`
 * (`parameters`, not `inputSchema`) so the response is already protocol-shaped
 * when MCA transport moves to the session plane. The disk-side type,
 * `StaticToolDefinition`, keeps `inputSchema` — that one describes `tools.json`,
 * and `toWireDetail` below is the only place the two names meet.
 */
export interface ToolDetail {
  /** The name the client asked for — possibly namespaced (`${appName}_${short}`). */
  requestedName: string
  /** The bare tool name as declared in tools.json. */
  name: string
  /**
   * The tool's description humanized as the catalog shows it
   * (`humanizeToolDescription`: the readable lead-in). @spec PERMW-REQ-2
   */
  description: string
  parameters: StaticToolDefinition["inputSchema"]
  annotations?: StaticToolDefinition["annotations"]
}

/**
 * The single mapping from the on-disk shape to the wire shape.
 * @spec PERMW-REQ-2
 */
function toWireDetail(requestedName: string, t: StaticToolDefinition): ToolDetail {
  return {
    requestedName,
    name: t.name,
    description: humanizeToolDescription(t.description),
    parameters: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }
}

interface GetToolDetailsData {
  appId?: string
  toolNames?: string[]
}

/**
 * The client holds namespaced tool names (`mydrive_share-file`) while tools.json
 * holds bare ones (`share-file`). Match exact first, then by `_`-delimited suffix.
 * Returns the requested name that matched, or undefined.
 *
 * MUST normalize the bare name to kebab-case before the suffix comparison.
 * `convertStaticTools` (mca-manager.tools.ts:124-125) registers the namespaced
 * form as `${appName}_${normalizeToolName(originalName)}` — every `_` inside the
 * tool's own name is rewritten to `-` there. Several shipped MCAs have snake_case
 * tool names end-to-end: mca.monday (15/15 tools), mca.todoist (15/15), mca.kelify
 * (3/3). Comparing against the raw (non-normalized) `bareName` for those apps
 * means the suffix never matches — e.g. `monday_list_boards` reaches the client
 * as `<appName>_monday-list-boards`, but an unnormalized check looks for
 * `..._monday_list_boards`, which does not exist — so all 33 of those tools
 * silently return no metadata with no error surfaced. `test-mca-tool.ts:80-87`
 * hit this exact trap on the execute path and prescribes the fix: use the SAME
 * shared normalizer as the registration path so the two can never drift. Do NOT
 * "simplify" this back to a plain string comparison.
 */
function matchRequestedName(bareName: string, requested: string[]): string | undefined {
  const kebab = normalizeToolName(bareName)
  const exact = requested.find((r) => r === bareName || r === kebab)
  if (exact) return exact
  return requested.find((r) => r.endsWith(`_${kebab}`))
}

/**
 * Response: `{ appId, appName?, mcaId, tools }`. `appName` is the catalog name
 * of the app (`mca_catalog.name`), omitted when the catalog has no entry.
 * @spec PERMW-REQ-2
 */
export function createGetToolDetailsHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
) {
  return async function getToolDetails(ctx: WsHandlerContext, rawData: unknown) {
    const { appId, toolNames } = (rawData ?? {}) as GetToolDetailsData

    if (!appId) {
      throw new HandlerError("MISSING_APP_ID", "getToolDetails: appId is required")
    }
    if (!Array.isArray(toolNames) || toolNames.length === 0) {
      throw new HandlerError(
        "MISSING_TOOL_NAMES",
        `getToolDetails: toolNames must be a non-empty array (appId=${appId})`,
      )
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError("APP_NOT_FOUND", `getToolDetails: app not found (appId=${appId})`)
    }
    assertAppVisible(mcaService, app, ctx.userId)

    // Access check — identical to get-tools.ts:29-40.
    const canAccess =
      app.ownerId === ctx.userId ||
      app.ownerId === "system" ||
      (workspaceService && (await workspaceService.canAccess(app.ownerId, ctx.userId)))
    if (!canAccess) {
      throw new HandlerError(
        "ACCESS_DENIED",
        `getToolDetails: access denied (appId=${appId}, userId=${ctx.userId})`,
      )
    }

    // Checked AFTER the access gate so a denied caller never learns whether the
    // schema source is available.
    if (!mcaManager) {
      throw new HandlerError(
        "MCA_MANAGER_UNAVAILABLE",
        `getToolDetails: McaManager is not available (appId=${appId})`,
      )
    }

    // Principle 6: mcaId comes from the app record, never from the request.
    const mcaId = app.mcaId
    const tools: ToolDetail[] = []

    for (const t of mcaManager.getStaticToolsForMca(mcaId)) {
      // `_`-prefixed tools are private: `convertStaticTools`
      // (mca-manager.tools.ts:128) skips them, so they never reach the LLM or the
      // client. This handler reads the RAW static list, so without the same skip
      // a caller could name one explicitly and read metadata the registration
      // path deliberately withholds. The two paths must agree.
      if (t.name.startsWith("_")) continue

      const requestedName = matchRequestedName(t.name, toolNames)
      if (!requestedName) continue

      // Broken tools.json: skip this tool, capture, keep returning the rest —
      // same discretion default as get-mca-tool-schemas.
      if (!t.inputSchema || typeof t.inputSchema.properties === "undefined") {
        const err = new Error(
          `[GetToolDetails] Broken tools.json: tool "${t.name}" in mca "${mcaId}" is missing inputSchema.properties`,
        )
        log.error({ err, mcaId, toolName: t.name }, err.message)
        captureException(err, { context: "getToolDetails", mcaId, toolName: t.name })
        continue
      }

      tools.push(toWireDetail(requestedName, t))
    }

    // PERMW-REQ-2: the app's display name is the catalog name.
    const catalogEntry = await mcaService.getMcaFromCatalog(mcaId)
    const appName = catalogEntry?.name

    return { appId, ...(appName ? { appName } : {}), mcaId, tools }
  }
}
