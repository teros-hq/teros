/**
 * Rebuild agent usage projections from `agent_usage_events`.
 *
 * Modes:
 *   --dry-run    Count and validate without writing.
 *   --shadow     Build into *_v2 collections and atomically rename at the end.
 *                Original collections keep serving reads during the rebuild.
 *   --confirm    Required for destructive (non-shadow) mode. Drops projections
 *                and rebuilds in place.
 *
 * Examples:
 *   bun packages/backend/src/scripts/rebuild-agent-usage-projections.ts --dry-run
 *   bun packages/backend/src/scripts/rebuild-agent-usage-projections.ts --shadow
 *   bun packages/backend/src/scripts/rebuild-agent-usage-projections.ts --confirm
 *
 *
 */

import { MongoClient } from "mongodb"
import { createLogger } from "../lib/logger"
import { secrets } from "../secrets/secrets-manager"
import { AgentUsageEventApplicationsRepository } from "../services/agent-usage-event-applications-repository"
import { AgentUsageEventApplier } from "../services/agent-usage-event-applier"
import { AgentUsageEventRepository } from "../services/agent-usage-event-repository"
import { ensureProjectionIndexes } from "../services/agent-usage-projection-index-specs"
import { AgentUsageSessionRepository } from "../services/agent-usage-session-repository"
import { ToolExecutionRepository } from "../services/tool-execution-repository"
import type { AgentUsageEvent } from "../types/database"

const log = createLogger("RebuildAgentUsage")

interface Args {
  dryRun: boolean
  shadow: boolean
  confirm: boolean
}

function parseArgs(): Args {
  const argv = new Set(process.argv.slice(2))
  return {
    dryRun: argv.has("--dry-run"),
    shadow: argv.has("--shadow"),
    confirm: argv.has("--confirm"),
  }
}

async function rebuild() {
  const args = parseArgs()
  log.info({ args }, "Rebuild starting")

  if (!args.dryRun && !args.shadow && !args.confirm) {
    log.error("Refusing to rebuild without --dry-run, --shadow, or --confirm")
    process.exit(2)
  }

  // `secrets.system()` throws "Secrets not loaded" without this — the recovery
  // path never ran successfully. Every working script loads first (A1.1).
  await secrets.load()
  const mongoSecret = secrets.system("mongodb") as { uri: string; dbName: string } | undefined
  if (!mongoSecret) {
    log.error("Missing .secrets/system/mongodb.json")
    process.exit(2)
  }
  const client = new MongoClient(mongoSecret.uri)
  await client.connect()
  const db = client.db(mongoSecret.dbName)

  try {
    // Choose target collection names
    const sessionsCol = args.shadow ? "agent_usage_sessions_v2" : "agent_usage_sessions"
    const toolsCol = args.shadow ? "tool_executions_v2" : "tool_executions"
    const applicationsCol = args.shadow
      ? "agent_usage_event_applications_v2"
      : "agent_usage_event_applications"

    if (!args.dryRun && !args.shadow) {
      log.warn({ sessionsCol, toolsCol }, "Dropping current projections (in-place rebuild)")
      await db.collection(sessionsCol).deleteMany({})
      await db.collection(toolsCol).deleteMany({})
      await db.collection(applicationsCol).deleteMany({})
    }

    if (args.shadow) {
      // Create shadow collections with the same shape (no indexes — Mongo
      // auto-creates the _id, which is enough for the rebuild itself; before
      // the rename we recreate the indexes via the migration script).
      for (const name of [sessionsCol, toolsCol, applicationsCol]) {
        try {
          await db.createCollection(name)
        } catch (err) {
          const error = err as { code?: number }
          if (error.code !== 48) throw err // 48 = NamespaceExists
        }
      }
    }

    const events = new AgentUsageEventRepository(db)
    const applications = new AgentUsageEventApplicationsRepository(
      args.shadow ? db : db, // applicationsCol differs only in name
    )
    // Construct a custom applications repo against the shadow collection name
    const applicationsCustomCol = db.collection(applicationsCol)
    const sessions = new AgentUsageSessionRepository(db)
    const tools = new ToolExecutionRepository(db)
    // For shadow rebuild we need repositories pointing to v2 collections.
    // The simplest cleanly-typed approach is to construct AgentUsageEventApplier
    // with custom repos that hit the chosen collection names.
    const applier = new AgentUsageEventApplier(
      {
        async tryClaim(eventId: string) {
          try {
            await applicationsCustomCol.insertOne({ eventId, projectedAt: new Date() })
            return true
          } catch (err) {
            const e = err as { code?: number }
            if (e.code === 11000) return false
            throw err
          }
        },
      } as unknown as InstanceType<typeof AgentUsageEventApplicationsRepository>,
      args.shadow ? buildAltSessionsRepo(db, sessionsCol) : sessions,
      args.shadow ? buildAltToolsRepo(db, toolsCol) : tools,
      log,
    )

    let total = 0
    let applied = 0
    const cursor = events.findAllOrdered()
    try {
      const batch: AgentUsageEvent[] = []
      for await (const event of cursor) {
        batch.push(event as unknown as AgentUsageEvent)
        total++
        if (batch.length >= 500) {
          if (!args.dryRun) {
            applied += await applier.applyBatch(batch)
          }
          batch.length = 0
        }
      }
      if (batch.length > 0 && !args.dryRun) {
        applied += await applier.applyBatch(batch)
      }
    } finally {
      await cursor.close()
    }

    log.info({ total, applied, dryRun: args.dryRun }, "Rebuild events processed")

    if (args.shadow && !args.dryRun) {
      log.info("Renaming shadow collections to live names")
      await renameAtomic(db, sessionsCol, "agent_usage_sessions")
      await renameAtomic(db, toolsCol, "tool_executions")
      await renameAtomic(db, applicationsCol, "agent_usage_event_applications")
      // The shadow collections were created with only the default _id index, so
      // the renamed-in live collections would lose their unique keys + TTLs.
      // Recreate them from the shared specs (A1.3) — idempotent, so a no-op when
      // they somehow survived.
      const indexCount = await ensureProjectionIndexes(db)
      log.info({ indexCount }, "Recreated projection indexes on live collections")
    }
  } finally {
    await client.close()
  }
}

async function renameAtomic(
  db: import("mongodb").Db,
  sourceName: string,
  targetName: string,
): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const backupName = `${targetName}_backup_${ts}`
  try {
    await db.collection(targetName).rename(backupName, { dropTarget: false })
    log.info({ targetName, backupName }, "Renamed live → backup")
  } catch (err) {
    const e = err as { code?: number }
    if (e.code !== 26) throw err // 26 = NamespaceNotFound
  }
  await db.collection(sourceName).rename(targetName, { dropTarget: false })
  log.info({ sourceName, targetName }, "Renamed shadow → live")
}

function buildAltSessionsRepo(
  db: import("mongodb").Db,
  collectionName: string,
): AgentUsageSessionRepository {
  const repo = new AgentUsageSessionRepository(db)
  // Reach inside: rebind the private col to the target collection. Since
  // AgentUsageSessionRepository owns `col` via constructor, the easy patch is
  // to construct it and then overwrite via `as any` for this script only.
  ;(repo as unknown as { col: import("mongodb").Collection }).col = db.collection(collectionName)
  return repo
}

function buildAltToolsRepo(
  db: import("mongodb").Db,
  collectionName: string,
): ToolExecutionRepository {
  const repo = new ToolExecutionRepository(db)
  ;(repo as unknown as { col: import("mongodb").Collection }).col = db.collection(collectionName)
  return repo
}

rebuild().catch((err) => {
  log.error({ err }, "Rebuild failed")
  process.exit(1)
})
