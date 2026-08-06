/**
 * Apply all pending migrations out-of-band.
 *
 * The project has NO standalone migrate CLI — migrations normally run at server
 * startup via `runMigrations(db)` (bootstrap/server-bootstrap.ts ~line 728). This
 * script mirrors that call so schema changes can be applied without a full server
 * boot. The runner's `_migrations` tracker makes it idempotent: already-applied
 * migrations are skipped, so re-running is safe.
 *
 * Usage: tsx src/scripts/apply-migrations.ts
 */
import { MongoClient } from "mongodb"
import { runMigrations } from "../migrations/runner"

async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || "teros"
  const client = new MongoClient(mongoUri)
  await client.connect()
  try {
    const db = client.db(mongoDatabase)
    await runMigrations(db)
    console.log(`[apply-migrations] Done against ${mongoUri}/${mongoDatabase}`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
