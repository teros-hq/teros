/**
 * Admin access audit-log for session-detail traces (TER-671 / A6.3).
 *
 * The session trace exposes cross-tenant conversation structure (and, for
 * supers, the plaintext a founding partner wrote). Every read must leave a
 * record. Ledger-first: the caller writes this BEFORE returning the trace, and a
 * write failure PROPAGATES — "no audit, no access" — so a broken audit path can
 * never silently produce unlogged reads of private conversations.
 */
import type { Db } from "mongodb"
import type { AgentUsageAccessLog } from "../types/database.js"

const COLLECTION = "agent_usage_access_log"

/**
 * Append one access record. Throws if the insert fails (the caller must let it
 * propagate so the trace is not returned when the access could not be logged).
 */
export async function recordSessionDetailAccess(
  db: Db,
  entry: {
    adminUserId: string
    role: "admin" | "super"
    sessionUsageId: string
    textIncluded: boolean
    at?: Date
  },
): Promise<void> {
  const doc: AgentUsageAccessLog = {
    adminUserId: entry.adminUserId,
    role: entry.role,
    sessionUsageId: entry.sessionUsageId,
    textIncluded: entry.textIncluded,
    at: entry.at ?? new Date(),
    schemaVersion: 1,
  }
  await db.collection<AgentUsageAccessLog>(COLLECTION).insertOne(doc)
}
