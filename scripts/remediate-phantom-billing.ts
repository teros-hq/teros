#!/usr/bin/env tsx
/**
 * TER-652 — reverse phantom-session over-billing.
 *
 * Corrects `agentHoursUsed` for subscriptions inflated by phantom sessions
 * (reconciler zombies / failed 0-token turns) that were billed before the
 * TER-650 fix. Recomputes the affected rollups, writes an append-only corrective
 * ledger entry, and decrements the counter to the real work.
 *
 * ⚠️  RUN ONLY AFTER the TER-650 fix is deployed — otherwise the bleeding
 *     continues and the correction chases a moving target.
 *
 * Usage (dry-run is the default; pass --apply to write):
 *   MONGODB_URI=... MONGODB_DATABASE=teros \
 *     tsx scripts/remediate-phantom-billing.ts --since 2026-06-01T00:00:00Z
 *   # then, after reviewing the dry-run report:
 *   MONGODB_URI=... MONGODB_DATABASE=teros \
 *     tsx scripts/remediate-phantom-billing.ts --since 2026-06-01T00:00:00Z --apply
 *
 * --since should be the incident start (when the phantom sessions began). It
 * bounds how far back the scan looks; older buckets outside any active period's
 * billed range are ignored anyway.
 */

import { MongoClient } from "mongodb"
import pino from "pino"
import { PhantomBillingRemediation } from "../packages/backend/src/services/phantom-billing-remediation"

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = process.env.MONGODB_DATABASE || "teros"

function parseArgs(): { apply: boolean; since: Date } {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const sinceIdx = args.indexOf("--since")
  const sinceRaw = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined
  if (!sinceRaw) {
    console.error("Error: --since <ISO date> is required (the incident start).")
    process.exit(2)
  }
  const since = new Date(sinceRaw)
  if (Number.isNaN(since.getTime())) {
    console.error(`Error: invalid --since date: ${sinceRaw}`)
    process.exit(2)
  }
  return { apply, since }
}

async function main(): Promise<void> {
  const { apply, since } = parseArgs()
  const log = pino({ level: process.env.LOG_LEVEL || "info" })
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const db = client.db(DB_NAME)
  try {
    const report = await new PhantomBillingRemediation(db, log).run({ since, dryRun: !apply })
    console.log(JSON.stringify(report, null, 2))
    if (apply) {
      console.log(
        `\n✅ APPLIED: ${report.subsCorrected}/${report.subsScanned} subs corrected, ` +
          `${report.totalHoursReturned.toFixed(3)}h returned across ${report.affectedBuckets} buckets.`,
      )
    } else {
      console.log(
        `\n🔍 DRY-RUN: would correct ${report.subsCorrected}/${report.subsScanned} subs, ` +
          `${report.totalHoursReturned.toFixed(3)}h. Re-run with --apply to write.`,
      )
    }
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
