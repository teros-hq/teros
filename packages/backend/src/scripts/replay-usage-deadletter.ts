/**
 * Re-apply usage events from the dead-letter file(s).
 *
 * The UsageEventBuffer writes batches that fail to persist (after 3 retries)
 * to `logs/usage-events-dead-letter-<timestamp>.ndjson`. This script reads
 * them and re-applies via the same Repository + Applier pair used in the
 * online path. Idempotent: `agent_usage_event_applications` rejects events
 * already applied.
 *
 * Usage:
 *   bun packages/backend/src/scripts/replay-usage-deadletter.ts [--logs-dir <path>] [--dry-run]
 */

import { open, readdir, rename } from "node:fs/promises"
import { resolve } from "node:path"
import { MongoClient } from "mongodb"
import { createLogger } from "../lib/logger"
import { secrets } from "../secrets/secrets-manager"
import { AgentUsageEventApplicationsRepository } from "../services/agent-usage-event-applications-repository"
import { AgentUsageEventApplier } from "../services/agent-usage-event-applier"
import { AgentUsageEventRepository } from "../services/agent-usage-event-repository"
import { AgentUsageSessionRepository } from "../services/agent-usage-session-repository"
import { parseDeadLetterEvent } from "../services/dead-letter-event-parser"
import { ToolExecutionRepository } from "../services/tool-execution-repository"
import type { AgentUsageEvent } from "../types/database"

const log = createLogger("ReplayDeadLetter")

async function replay() {
  const argv = process.argv.slice(2)
  const logsDirIdx = argv.indexOf("--logs-dir")
  const logsDir = logsDirIdx >= 0 ? resolve(argv[logsDirIdx + 1]) : resolve(process.cwd(), "logs")
  const dryRun = argv.includes("--dry-run")

  // `secrets.system()` throws "Secrets not loaded" without this — the replay
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
    const events = new AgentUsageEventRepository(db)
    const applier = new AgentUsageEventApplier(
      new AgentUsageEventApplicationsRepository(db),
      new AgentUsageSessionRepository(db),
      new ToolExecutionRepository(db),
      log,
    )

    let entries: string[]
    try {
      entries = (await readdir(logsDir)).filter(
        (name) => name.startsWith("usage-events-dead-letter-") && name.endsWith(".ndjson"),
      )
    } catch {
      log.warn({ logsDir }, "Logs dir not readable; nothing to replay")
      return
    }

    if (entries.length === 0) {
      log.info({ logsDir }, "No dead-letter files found")
      return
    }

    let totalLines = 0
    let totalInserted = 0
    let totalApplied = 0

    for (const entry of entries) {
      const fullPath = resolve(logsDir, entry)
      log.info({ file: fullPath }, "Replaying file")
      const batch: AgentUsageEvent[] = []
      const fh = await open(fullPath, "r")
      try {
        const stream = fh.createReadStream({ encoding: "utf8" })
        let buf = ""
        for await (const chunk of stream) {
          buf += chunk as string
          let nl = buf.indexOf("\n")
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            nl = buf.indexOf("\n")
            if (!line) continue
            totalLines++
            try {
              // Rehydrate Date fields (appliedAt, payload.startedAt/endedAt) so
              // the replayed events match the online shape — a plain JSON.parse
              // reinserts them as strings, breaking TTL + date-range queries (A1.6).
              const event = parseDeadLetterEvent(line)
              batch.push(event)
              if (batch.length >= 500) {
                if (!dryRun) {
                  totalInserted += await events.bulkInsert(batch)
                  totalApplied += await applier.applyBatch(batch)
                }
                batch.length = 0
              }
            } catch (err) {
              log.error({ err, file: fullPath, line: line.slice(0, 80) }, "Bad JSON; skipping line")
            }
          }
        }
        if (batch.length > 0 && !dryRun) {
          totalInserted += await events.bulkInsert(batch)
          totalApplied += await applier.applyBatch(batch)
        }
      } finally {
        await fh.close()
      }

      if (!dryRun) {
        const processedPath = `${fullPath}.processed`
        await rename(fullPath, processedPath)
        log.info({ from: fullPath, to: processedPath }, "Renamed processed file")
      }
    }

    log.info({ totalLines, totalInserted, totalApplied, dryRun }, "Replay complete")
  } finally {
    await client.close()
  }
}

replay().catch((err) => {
  log.error({ err }, "Replay failed")
  process.exit(1)
})
