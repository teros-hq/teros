/**
 * Repository for `tool_executions` (append-only, one per tool invocation).
 *
 *
 */

import type { Collection, Db, Filter, UpdateFilter } from "mongodb"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"
import type { ToolExecution } from "../types/database.js"

export class ToolExecutionRepository {
  private col: Collection<ToolExecution>

  constructor(db: Db) {
    this.col = db.collection<ToolExecution>("tool_executions")
  }

  async insert(tool: ToolExecution): Promise<boolean> {
    try {
      await this.col.insertOne(tool)
      return true
    } catch (err) {
      if (isMongoDuplicateKey(err)) return false
      throw err
    }
  }

  async update(
    toolExecutionId: string,
    update: UpdateFilter<ToolExecution>,
    filter?: Filter<ToolExecution>,
  ): Promise<boolean> {
    const result = await this.col.updateOne(
      { toolExecutionId, ...(filter ?? {}) },
      update,
    )
    return result.matchedCount > 0
  }

  findById(toolExecutionId: string): Promise<ToolExecution | null> {
    return this.col.findOne({ toolExecutionId })
  }

  // Bounded like the session repo's findStale: cap a pathological backlog to
  // one tick's worth; the next tick picks up the rest (TER-650).
  findStale(cutoff: Date, limit = 1000) {
    return this.col
      .find({
        status: "running",
        startedAt: { $lt: cutoff },
      })
      .limit(limit)
  }

  collection(): Collection<ToolExecution> {
    return this.col
  }
}
