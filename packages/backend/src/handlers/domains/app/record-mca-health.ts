/**
 * app.record-mca-health — Batch upsert MCA tool-health results (admin)
 *
 * Accepts a batch of 1..N results and upserts each by (mcaId, tool) so
 * re-recording the same tool overwrites rather than appends (D-03). One code
 * path serves both Phase 8 flows (per-tool Retest = 1-element array,
 * whole-MCA Test = N). `testedAt` is server-generated once per batch (D-05,
 * tamper-resistant); `error` is truncated to 500 chars at the boundary (D-06);
 * appId/inputs/outputs are never written (D-07 / SC3). Admin-gated (SC2).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import type { McaToolHealth, ToolTestStatus } from "../../../types/database"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface RecordMcaHealthResult {
  mcaId: string
  tool: string
  status: ToolTestStatus
  error?: string
}

interface RecordMcaHealthData {
  results?: RecordMcaHealthResult[]
}

// Enum boundary guard: the dashboard's `overall` derivation only handles these
// members, so an out-of-enum status (e.g. "garbage") would persist and render
// as an unknown state. Keep in sync with ToolTestStatus in types/database.ts.
const VALID_STATUSES: ReadonlySet<string> = new Set<ToolTestStatus>([
  "ok",
  "pending",
  "fail",
  "confirm",
  "skip",
])

export function createRecordMcaHealthHandler(db: Db) {
  return async function recordMcaHealth(ctx: WsHandlerContext, rawData: unknown) {
    // Admin-only: fleet health is global catalog state (SC2, T-05-04).
    await requireSystemAdmin(db, ctx.userId)

    const data = rawData as RecordMcaHealthData
    const results = data?.results
    if (!Array.isArray(results) || results.length === 0) {
      throw new HandlerError("INVALID_REQUEST", "results must be a non-empty array")
    }

    // Validate the WHOLE batch before writing anything. Validating inside the
    // write loop meant a malformed element at index k threw only after 0..k-1
    // were already upserted, durably applying a partial batch while the caller
    // saw a failed request (and a naive retry double-processed the prefix).
    for (const r of results) {
      if (!r.mcaId || !r.tool || !r.status) {
        throw new HandlerError("INVALID_REQUEST", "each result needs mcaId, tool, status")
      }
      // Validate status membership at the boundary — not just truthiness — so a
      // malformed batch can't durably persist a status the dashboard can't render.
      if (!VALID_STATUSES.has(r.status)) {
        throw new HandlerError(
          "INVALID_REQUEST",
          `invalid status "${r.status}" for ${r.mcaId}/${r.tool}; expected one of ok|pending|fail|confirm|skip`,
        )
      }
    }

    // D-05: single server-generated timestamp shared by the whole batch; any
    // client-supplied timestamp is ignored (tamper-resistant, T-05-05).
    const testedAt = new Date()
    const col = db.collection<McaToolHealth>("mca_tool_health")

    // One bulkWrite round-trip for the whole batch (a 15-tool whole-MCA Test was
    // 15 serialized round-trips as per-result updateOne calls). Same per-op
    // semantics as before:
    //   D-03: upsert-overwrite by (mcaId, tool); filter keys never appear in $set.
    //   D-07: never write appId/inputs/outputs.
    //   Recovered-to-ok: when the new result carries no error, $unset the
    //   previously-stored error — otherwise the upsert-overwrite leaves the old
    //   error on the document and a later read renders a stale note for a
    //   now-passing tool.
    await col.bulkWrite(
      results.map((r) => {
        // D-06: server-truncate error to ~500 chars at the boundary (SC3, T-05-06).
        const error = r.error ? r.error.slice(0, 500) : undefined
        return {
          updateOne: {
            filter: { mcaId: r.mcaId, tool: r.tool },
            update: {
              $set: {
                status: r.status,
                testedAt,
                updatedAt: testedAt,
                ...(error ? { error } : {}),
              },
              ...(error ? {} : { $unset: { error: "" } }),
              $setOnInsert: { createdAt: testedAt },
            },
            upsert: true,
          },
        }
      }),
    )

    return { recorded: results.length }
  }
}
