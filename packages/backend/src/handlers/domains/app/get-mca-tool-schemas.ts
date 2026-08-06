/**
 * app.get-mca-tool-schemas — Read per-tool inputSchema + requiresInput for an mcaId (admin)
 *
 * Returns, for a catalog `mcaId`, each static tool's `inputSchema` verbatim (D-02)
 * plus a `requiresInput` flag (D-01: true iff inputSchema.properties is non-empty).
 * Sourced from the existing static tool defs (SC1) — works from a catalog mcaId
 * alone, with no workspace-installed appId required (SC2). Admin-gated via
 * requireSystemAdmin as the first executable line (D-04, TER-447 invariant).
 *
 * Discretion defaults: an unknown/absent mcaId (no catalog entry / no tools.json)
 * returns { tools: [] } instead of throwing; a tool whose inputSchema.properties is
 * missing is skipped (captured/logged) and the remaining tools are still returned.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import { HandlerError } from "../../../ws-framework/WsRouter"
import type { McaManager } from "../../../services/mca-manager"
import type { StaticToolDefinition } from "../../../services/mca-manager.types"
import { captureException } from "../../../lib/sentry"
import { createLogger } from "../../../lib/logger"

const log = createLogger("GetMcaToolSchemas")

export function createGetMcaToolSchemasHandler(mcaManager: McaManager | null, db: Db) {
  return async function getMcaToolSchemas(ctx: WsHandlerContext, rawData: unknown) {
    // Admin-only: tool schemas are global catalog state (SC2, D-04, TER-447).
    // MUST be the first executable line — the schema source is never invoked
    // on denial (Task 3 case 1 asserts this invariant).
    await requireSystemAdmin(db, ctx.userId)

    const { mcaId } = rawData as { mcaId?: string }
    if (!mcaId) {
      throw new HandlerError("INVALID_REQUEST", "mcaId is required")
    }

    // No schema source available → graceful empty (no throw).
    if (!mcaManager) {
      return {
        tools: [] as Array<{
          tool: string
          inputSchema: StaticToolDefinition["inputSchema"]
          requiresInput: boolean
          annotations?: StaticToolDefinition["annotations"]
        }>,
      }
    }

    // loadStaticTools returns [] for an unknown/absent mcaId → graceful empty.
    const staticTools = mcaManager.getStaticToolsForMca(mcaId)

    const tools: Array<{
      tool: string
      inputSchema: StaticToolDefinition["inputSchema"]
      requiresInput: boolean
      annotations?: StaticToolDefinition["annotations"]
    }> = []

    for (const t of staticTools) {
      // Broken-defs default: skip a tool with missing inputSchema.properties,
      // log + capture, and keep returning the remaining well-formed tools
      // (mirror convertStaticTools' guard shape).
      if (!t.inputSchema || typeof t.inputSchema.properties === "undefined") {
        const err = new Error(
          `[GetMcaToolSchemas] Broken tools.json: tool "${t.name}" in mca "${mcaId}" is missing inputSchema.properties`,
        )
        log.error({ err, mcaId, toolName: t.name, inputSchema: t.inputSchema }, err.message)
        captureException(err, {
          context: "getMcaToolSchemas",
          mcaId,
          toolName: t.name,
          inputSchema: t.inputSchema,
        })
        continue
      }

      // D-01: requiresInput is true iff at least one property is declared
      // (even an only-optional property → true); zero properties → false.
      const requiresInput = Object.keys(t.inputSchema.properties).length > 0

      // D-02: inputSchema returned verbatim — do not trim, re-derive, or reshape.
      // Additive: carry the manifest annotations through when the static def declares
      // them, so the client can classify read-only vs destructive for the run order
      // (T-08-04, feeds resolveToolAnnotations). Omit the key otherwise.
      tools.push({
        tool: t.name,
        inputSchema: t.inputSchema,
        requiresInput,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })
    }

    return { tools }
  }
}
