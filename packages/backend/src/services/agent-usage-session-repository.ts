/**
 * Repository for `agent_usage_sessions` (projection, one per turn).
 *
 * Pure CRUD. Domain logic (classifyError, deriveStatus, etc.) lives in
 * `agent-usage-session-service.ts`.
 *
 *
 */

import type { Collection, Db, Filter, UpdateFilter } from "mongodb"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"
import type { AgentUsageSession } from "../types/database.js"

export class AgentUsageSessionRepository {
  private col: Collection<AgentUsageSession>

  constructor(db: Db) {
    this.col = db.collection<AgentUsageSession>("agent_usage_sessions")
  }

  /**
   * Insert a new session. Used by the applier when consuming `session.started`.
   * Idempotent via `{sessionUsageId:1}` unique index (re-applied → 11000 → skip).
   */
  async insert(session: AgentUsageSession): Promise<boolean> {
    try {
      await this.col.insertOne(session)
      return true
    } catch (err) {
      if (isMongoDuplicateKey(err)) return false
      throw err
    }
  }

  /**
   * Generic update by sessionUsageId. Used by the applier for delta / ended /
   * descendant counter propagation.
   */
  async update(
    sessionUsageId: string,
    update: UpdateFilter<AgentUsageSession>,
    filter?: Filter<AgentUsageSession>,
  ): Promise<boolean> {
    const result = await this.col.updateOne(
      { sessionUsageId, ...(filter ?? {}) },
      update,
    )
    return result.matchedCount > 0
  }

  /**
   * Find one session by id.
   */
  findById(sessionUsageId: string): Promise<AgentUsageSession | null> {
    return this.col.findOne({ sessionUsageId })
  }

  /**
   * Cursor over EXECUTION orphans: sessions stuck in `running` whose
   * execution-anchored `startedAt` is older than the cutoff (the process that
   * was driving the turn died past the turn deadline). Used by the reconciler.
   *
   * Bounded by `limit` (default 1000) so a pathological backlog of orphans
   * cannot load unbounded into a single reconciler tick. The reconciler closes
   * up to `limit` per run and the next tick picks up the rest — each close
   * flips the doc out of `running`, so progress is guaranteed. TER-650.
   */
  findStale(cutoff: Date, limit = 1000) {
    return this.col
      .find({
        status: "running",
        startedAt: { $lt: cutoff },
      })
      .limit(limit)
  }

  /**
   * Cursor over QUEUE orphans: sessions stuck in `queued` (never started
   * executing) whose `createdAt` is older than the cutoff — their ChannelWorker
   * died before draining them, so `session.running` will never fire. Keyed on
   * `createdAt` because a queued session has no `startedAt` yet (TER-650/G1).
   * Same `limit` bound + guaranteed-progress rationale as `findStale`.
   */
  findStaleQueued(cutoff: Date, limit = 1000) {
    return this.col
      .find({
        status: "queued",
        createdAt: { $lt: cutoff },
      })
      .limit(limit)
  }

  /**
   * Cursor over sessions started or active during a time window. Used by the
   * rollup job and ad-hoc queries.
   */
  findInTimeRange(from: Date, to: Date) {
    return this.col.find({
      $or: [
        { startedAt: { $gte: from, $lt: to } },
        // Sessions that started earlier but were still running at `from`
        { startedAt: { $lt: from }, endedAt: null },
        // Sessions that ended in the window but started earlier
        { startedAt: { $lt: from }, endedAt: { $gte: from, $lt: to } },
      ],
    })
  }

  /**
   * Direct access for query handlers that need rich aggregation pipelines.
   * Repositories above are meant for write paths; reads can go through here.
   */
  collection(): Collection<AgentUsageSession> {
    return this.col
  }
}
