/**
 * app.get-mca-resolvability — Admin-gated pre-flight read: is a catalog mcaId runnable? (Phase 7, SC3)
 *
 * Answers, per `mcaId`, whether the calling admin can run its tools — so the Phase 8 UI can
 * disable the Test button and show a reason on load, distinct from the execute call (D-06).
 *
 * It resolves via the SAME shared `resolveMcaApp` helper as `app.test-mca-tool`, so the
 * resolvability answer is guaranteed consistent with what execute would do, and the
 * not-installed wire shape is byte-identical (both use `NOT_INSTALLED_REASON`).
 *
 * Gate order (D-05, TER-447 invariant): `requireSystemAdmin` is the FIRST executable line —
 * no resolution runs on denial. The weaker workspace gate is NOT exposed here.
 *
 * D-07 (Claude's Discretion — credential pre-check feasibility):
 *   The guaranteed-cheap contract is runnable-vs-not-installed. A distinct `no-credentials`
 *   reason is intentionally NOT emitted here: "required credentials per MCA" is not cheaply
 *   knowable at resolve time — missing user auth only fails at spawn/run time, not at resolve
 *   (see 07-PATTERNS.md Secrets notes). Emitting a hard non-runnable on a credential probe would
 *   be a false negative for MCAs that need no user auth (system secrets only, or none). The spike
 *   therefore reports a credential-less-but-installed app as `runnable: true` and lets the tool
 *   fail at run time. This decision + its limitation is documented in Plan 03's PROJECT.md update
 *   (TEST-07 input).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import type { McaService } from "../../../services/mca-service"
import type { WorkspaceService } from "../../../services/workspace-service"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { type NOT_INSTALLED_REASON, resolveMcaApp } from "./mca-app-resolver"

export interface McaResolvability {
  runnable: boolean
  reason?: typeof NOT_INSTALLED_REASON
  appId?: string
}

export function createGetMcaResolvabilityHandler(
  mcaService: McaService,
  db: Db,
  workspaceService: WorkspaceService | null = null,
) {
  return async function getMcaResolvability(
    ctx: WsHandlerContext,
    rawData: unknown,
  ): Promise<McaResolvability> {
    // Admin-only. MUST be the first executable line — resolution is never invoked
    // on denial (D-05, TER-447 invariant asserted in the unit suite).
    await requireSystemAdmin(db, ctx.userId)

    const { mcaId } = rawData as { mcaId?: string }
    if (!mcaId) {
      throw new HandlerError("INVALID_REQUEST", "mcaId is required")
    }

    // Reuse the SAME D-02/D-03 resolution as app.test-mca-tool so the answers
    // agree and the not-installed wire shape stays byte-identical (D-06). The revised
    // D-02 scope covers the admin's own workspaces (07-03 spike: apps are workspace-owned).
    const resolution = await resolveMcaApp(mcaService, workspaceService, ctx.userId, mcaId)
    if (!resolution.resolved) {
      // Shared reason constant — single source of truth across both handlers (D-01/D-06).
      return { runnable: false, reason: resolution.reason }
    }

    return { runnable: true, appId: resolution.app.appId }
  }
}
