/**
 * Migration Script: Embedded Messages → Separate Collection
 *
 * Migrates sessions from the old schema (messages embedded in session document)
 * to the new schema (messages in separate collection, compactions in separate collection).
 *
 * Usage:
 *   bun run src/scripts/migrate-messages.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be migrated without making changes
 */

import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"

const __filename_local = fileURLToPath(import.meta.url)
const __dirname_local = dirname(__filename_local)

import { MongoSessionStore } from "../session/MongoSessionStore"

async function migrate(dryRun: boolean = false) {
  console.log("🔄 Message Migration: Embedded → Separate Collection\n")

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made\n")
  }

  // Load secrets and connect to MongoDB
  const secretsPath = join(__dirname_local, "../../../../.secrets")
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"

  const mongoClient = new MongoClient(mongoUri)

  try {
    await mongoClient.connect()
    const db = mongoClient.db(mongoDatabase)

    // Get sessions with embedded messages
    const sessionsCollection = db.collection("sessions")
    const sessionsWithMessages = await sessionsCollection
      .find({
        messages: { $exists: true, $ne: [] },
      })
      .toArray()

    console.log(`📊 Found ${sessionsWithMessages.length} sessions with embedded messages\n`)

    if (sessionsWithMessages.length === 0) {
      console.log("✅ No migration needed - all sessions already migrated\n")
      return
    }

    // Show preview
    console.log("📋 Sessions to migrate:")
    for (const session of sessionsWithMessages.slice(0, 10)) {
      const msgCount = (session.messages as any[])?.length || 0
      const hasCompaction = !!(session as any).compaction?.summary
      console.log(`   - ${session.id}: ${msgCount} messages${hasCompaction ? " + compaction" : ""}`)
    }
    if (sessionsWithMessages.length > 10) {
      console.log(`   ... and ${sessionsWithMessages.length - 10} more`)
    }
    console.log("")

    if (dryRun) {
      console.log("🔍 DRY RUN - Skipping actual migration\n")

      // Show stats
      let totalMessages = 0
      let totalCompactions = 0
      for (const session of sessionsWithMessages) {
        totalMessages += (session.messages as any[])?.length || 0
        if ((session as any).compaction?.summary) {
          totalCompactions++
        }
      }

      console.log("📊 Would migrate:")
      console.log(`   Sessions: ${sessionsWithMessages.length}`)
      console.log(`   Messages: ${totalMessages}`)
      console.log(`   Compactions: ${totalCompactions}`)
      return
    }

    // Perform migration
    console.log("💾 Starting migration...\n")

    const store = new MongoSessionStore(db)
    const result = await store.migrateAllSessions()

    console.log("\n✅ Migration complete!")
    console.log(`   Migrated: ${result.migrated} sessions`)
    console.log(`   Skipped: ${result.skipped} sessions (already migrated or empty)`)

    // Verify
    console.log("\n🔍 Verifying migration...")

    const messagesCollection = db.collection("messages")
    const compactionsCollection = db.collection("compactions")

    const messageCount = await messagesCollection.countDocuments()
    const compactionCount = await compactionsCollection.countDocuments()
    const remainingEmbedded = await sessionsCollection.countDocuments({
      messages: { $exists: true, $ne: [] },
    })

    console.log(`   Messages in collection: ${messageCount}`)
    console.log(`   Compactions in collection: ${compactionCount}`)
    console.log(`   Sessions still with embedded messages: ${remainingEmbedded}`)

    if (remainingEmbedded > 0) {
      console.log("\n⚠️  Some sessions still have embedded messages. Re-run migration to complete.")
    } else {
      console.log("\n✅ All sessions successfully migrated!")
    }
  } catch (error) {
    console.error("❌ Migration failed:", error)
    throw error
  } finally {
    await mongoClient.close()
  }
}

// Run if called directly
if (import.meta.main) {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")

  migrate(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

export { migrate }
