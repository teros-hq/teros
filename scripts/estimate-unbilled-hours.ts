#!/usr/bin/env tsx
/**
 * BIL-2 / BIL-3 — estimate agent-hours that were never billed.
 *
 * Before the billable-horizon fix, an hour could be rolled up and billed
 * before its numbers were final (sessions still open across it), or skipped
 * by the tracker cursor after a failure. Those hours are never revisited, so
 * their missing time was lost.
 *
 * For every hour bucket in [--since, --until) that each active subscription
 * has already billed (≤ lastBilledHourBucket), this compares the stored
 * user-hourly rollup with the same aggregation recomputed now from the
 * sessions (the rollup job's own read-only computeUserActiveMsForHour). A
 * positive difference is time that was worked but not billed.
 *
 * READ-ONLY: it reports; it never writes. Whether to charge it retroactively
 * is a business decision.
 *
 * Usage:
 *   MONGODB_URI=... MONGODB_DATABASE=teros \
 *     tsx scripts/estimate-unbilled-hours.ts --since 2026-09-01T00:00:00Z [--until 2026-10-17T00:00:00Z]
 */
import { MongoClient } from "mongodb"
import { estimateUnbilledHours } from "../packages/backend/src/services/unbilled-hours-estimate"

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = process.env.MONGODB_DATABASE || "teros"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const since = new Date(arg("--since") ?? "")
  const until = new Date(arg("--until") ?? new Date().toISOString())
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    console.error("Usage: --since <ISO date> [--until <ISO date>]")
    process.exit(2)
  }

  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    const rows = await estimateUnbilledHours(client.db(DB_NAME), since, until)
    console.log(JSON.stringify({ since, until, users: rows.length, rows }, null, 2))
    const total = rows.reduce((sum, r) => sum + r.unbilledHours, 0)
    console.log(`Total unbilled agent-hours: ${total.toFixed(3)} across ${rows.length} user(s)`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
