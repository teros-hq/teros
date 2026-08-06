/**
 * Migrate Users to Basic Plan (BETA free)
 *
 * One-time migration: all existing users without a subscription get
 * a Basic plan subscription with €0 price during BETA.
 *
 * Idempotent — safe to re-run. Users who already have a subscription
 * are skipped.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/migrate-users-to-basic-plan.ts [--dry-run]
 *
 * Example (dry run):
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/migrate-users-to-basic-plan.ts --dry-run
 *
 * Example (live):
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/migrate-users-to-basic-plan.ts
 */

import { MongoClient } from "mongodb"
import { config as dotenvConfig } from "dotenv"
import {
  getBillingSubscriptionsCollection,
  createDefaultSubscription,
} from "../packages/backend/src/models/billing"

dotenvConfig()

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"

const DRY_RUN = process.argv.includes("--dry-run")

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const db = client.db(DB_NAME)

  try {
    const subsCol = getBillingSubscriptionsCollection(db)
    const usersCol = db.collection("users")

    // Fetch all users (only need userId)
    const users = await usersCol.find({}, { projection: { userId: 1 } }).toArray()

    let migrated = 0
    let skipped = 0
    const errors: { userId: string; error: string }[] = []

    console.log(`Found ${users.length} total users`)
    if (DRY_RUN) {
      console.log("🔍 DRY RUN — no writes will be performed\n")
    }

    for (const user of users) {
      const userId = user.userId as string

      // Check if user already has a subscription
      const existing = await subsCol.findOne({ userId })
      if (existing) {
        skipped++
        continue
      }

      if (DRY_RUN) {
        console.log(`[DRY RUN] Would migrate user ${userId}`)
        migrated++
        continue
      }

      try {
        await createDefaultSubscription(db, userId)
        migrated++
        console.log(`✅ Migrated user ${userId}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push({ userId, error: msg })
        console.error(`❌ Failed to migrate user ${userId}: ${msg}`)
      }
    }

    console.log("\n──────────────────────────────")
    console.log("Migration complete")
    console.log(`  Total users scanned : ${users.length}`)
    console.log(`  Migrated            : ${migrated}`)
    console.log(`  Skipped (existing)  : ${skipped}`)
    console.log(`  Errors              : ${errors.length}`)
    if (errors.length > 0) {
      console.log("\nErrors:")
      for (const e of errors) {
        console.log(`  - ${e.userId}: ${e.error}`)
      }
      process.exit(1)
    }
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
