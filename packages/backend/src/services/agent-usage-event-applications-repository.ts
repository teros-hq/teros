/**
 * Repository for `agent_usage_event_applications`.
 *
 * Cross-restart idempotency log. The EventApplier inserts the eventId here
 * BEFORE applying the event to projections. On duplicate key (11000) the
 * event was already applied and is skipped silently.
 *
 * TTL 180d (matches `agent_usage_events`).
 *
 *
 */

import type { Collection, Db } from "mongodb"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"
import type { AgentUsageEventApplication } from "../types/database.js"

export class AgentUsageEventApplicationsRepository {
  private col: Collection<AgentUsageEventApplication>

  constructor(db: Db) {
    this.col = db.collection<AgentUsageEventApplication>("agent_usage_event_applications")
  }

  /**
   * Mark an event as applied.
   *
   * Returns `true` if this is the first time the event is being applied
   * (caller should proceed to apply to projections), `false` if the event was
   * already applied (caller should skip).
   */
  async tryClaim(eventId: string): Promise<boolean> {
    try {
      await this.col.insertOne({
        eventId,
        projectedAt: new Date(),
      })
      return true
    } catch (err) {
      if (isMongoDuplicateKey(err)) {
        // Already applied → skip
        return false
      }
      throw err
    }
  }
}
