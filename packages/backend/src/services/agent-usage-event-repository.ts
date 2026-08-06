/**
 * Repository for `agent_usage_events` (append-only source of truth).
 *
 * Events are bulk-inserted by the UsageEventBuffer in batches. The
 * EventApplier consumes them ordered by `appliedAt` and rebuilds projections.
 *
 *
 */

import type { AnyBulkWriteOperation, Collection, Db } from "mongodb"
import type { AgentUsageEvent } from "../types/database.js"

export class AgentUsageEventRepository {
  private col: Collection<AgentUsageEvent>

  constructor(db: Db) {
    this.col = db.collection<AgentUsageEvent>("agent_usage_events")
  }

  /**
   * Bulk insert events. Idempotent: existing eventIds are skipped because the
   * unique index on `{eventId:1}` raises `code 11000` for duplicates, and we
   * use `ordered:false` so one duplicate does not abort the rest of the batch.
   *
   * Returns the count of newly inserted documents.
   */
  async bulkInsert(events: AgentUsageEvent[]): Promise<number> {
    if (events.length === 0) return 0

    const ops: AnyBulkWriteOperation<AgentUsageEvent>[] = events.map((event) => ({
      insertOne: { document: event },
    }))

    try {
      const result = await this.col.bulkWrite(ops, { ordered: false })
      return result.insertedCount ?? 0
    } catch (err) {
      // BulkWriteError with code 11000 duplicates is expected when the same
      // event is replayed (deadletter, retries). Re-throw any other failure.
      const error = err as { code?: number; writeErrors?: Array<{ code: number }> }
      const allDuplicates =
        error.writeErrors?.every((e) => e.code === 11000) ?? error.code === 11000
      if (allDuplicates) {
        // Best-effort: count is in the bulk result attached to the error
        const writeResult = (err as { result?: { insertedCount?: number } }).result
        return writeResult?.insertedCount ?? 0
      }
      throw err
    }
  }

  /**
   * Stream events for a sessionUsageId in order. Used by the rebuild script.
   */
  findBySessionUsageId(sessionUsageId: string) {
    return this.col.find({ sessionUsageId }).sort({ appliedAt: 1 })
  }

  /**
   * Stream all events ordered by appliedAt. Used by full rebuild.
   */
  findAllOrdered() {
    return this.col.find({}).sort({ appliedAt: 1 })
  }
}
