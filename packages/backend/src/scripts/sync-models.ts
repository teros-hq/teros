/**
 * Sync Models Script
 *
 * Syncs LLM model definitions with the models collection in MongoDB.
 * Model definitions are centralized in src/models/definitions.ts
 *
 * Usage:
 *   bun run src/scripts/sync-models.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be synced without making changes
 */

import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { MODEL_DEFINITIONS } from "../models/definitions"
import { secrets } from "../secrets/secrets-manager"

const __filename_local = fileURLToPath(import.meta.url)
const __dirname_local = dirname(__filename_local)

import type { Model } from "../types/database"

// ============================================================================
// SYNC LOGIC
// ============================================================================

/**
 * Sync models with database
 */
async function syncModels(dryRun: boolean = false) {
  console.log("🔄 Syncing models with database...\n")

  const modelCount = MODEL_DEFINITIONS.length
  const providerCounts = MODEL_DEFINITIONS.reduce(
    (acc, m) => {
      acc[m.provider] = (acc[m.provider] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  console.log(`📦 Model definitions: ${modelCount}`)
  Object.entries(providerCounts).forEach(([provider, count]) => {
    console.log(`   ${provider}: ${count} models`)
  })
  console.log("")

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
    const modelsCollection = db.collection<Model>("models")

    // Get existing entries
    const existing = await modelsCollection.find({}).toArray()
    const existingMap = new Map(existing.map((m) => [m.modelId, m]))

    console.log(`📊 Database has ${existing.length} existing models\n`)

    // Determine changes
    const toInsert: Model[] = []
    const toUpdate: Model[] = []
    const toKeep: string[] = []
    const now = new Date().toISOString()

    for (const modelDef of MODEL_DEFINITIONS) {
      const model: Model = {
        ...modelDef,
        createdAt: now,
        updatedAt: now,
      }

      const existingModel = existingMap.get(model.modelId)

      if (!existingModel) {
        toInsert.push(model)
      } else {
        // Check if update needed
        const needsUpdate =
          existingModel.name !== model.name ||
          existingModel.description !== model.description ||
          existingModel.provider !== model.provider ||
          existingModel.modelString !== model.modelString ||
          JSON.stringify(existingModel.capabilities) !== JSON.stringify(model.capabilities) ||
          JSON.stringify(existingModel.context) !== JSON.stringify(model.context) ||
          JSON.stringify(existingModel.defaults) !== JSON.stringify(model.defaults) ||
          JSON.stringify(existingModel.reservations) !== JSON.stringify(model.reservations) ||
          JSON.stringify(existingModel.compaction) !== JSON.stringify(model.compaction) ||
          JSON.stringify(existingModel.providerConfig) !== JSON.stringify(model.providerConfig) ||
          existingModel.status !== model.status

        if (needsUpdate) {
          model.createdAt = existingModel.createdAt
          model.updatedAt = now
          toUpdate.push(model)
        } else {
          toKeep.push(model.modelId)
        }
      }
    }

    // Find orphaned models (in DB but not in definitions)
    const definedIds = new Set(MODEL_DEFINITIONS.map((m) => m.modelId))
    const orphans = existing.filter((m) => !definedIds.has(m.modelId))

    // Report changes
    console.log("📋 Changes:")

    if (toInsert.length > 0) {
      console.log(`\n  New models (${toInsert.length}):`)
      toInsert.forEach((m) => console.log(`    + ${m.modelId} (${m.name}) [${m.provider}]`))
    }

    if (toUpdate.length > 0) {
      console.log(`\n  Updated models (${toUpdate.length}):`)
      toUpdate.forEach((m) => console.log(`    ~ ${m.modelId} (${m.name})`))
    }

    if (toKeep.length > 0) {
      console.log(`\n  Unchanged models (${toKeep.length}):`)
      toKeep.forEach((id) => console.log(`    = ${id}`))
    }

    if (orphans.length > 0) {
      console.log(`\n  ⚠️  Orphaned models in DB (not in definitions):`)
      orphans.forEach((m) => console.log(`    ? ${m.modelId} (${m.name})`))
      console.log("    Note: These will be REMOVED from the database.")
    }

    // Apply changes
    if (dryRun) {
      console.log("\n🔍 DRY RUN - No changes applied\n")
    } else {
      console.log("\n💾 Applying changes...")

      // Insert new models
      if (toInsert.length > 0) {
        await modelsCollection.insertMany(toInsert)
        console.log(`  Inserted ${toInsert.length} new models`)
      }

      // Update existing models
      for (const model of toUpdate) {
        await modelsCollection.updateOne({ modelId: model.modelId }, { $set: model })
      }
      if (toUpdate.length > 0) {
        console.log(`  Updated ${toUpdate.length} models`)
      }

      // Remove orphaned models
      if (orphans.length > 0) {
        const orphanIds = orphans.map((m) => m.modelId)
        await modelsCollection.deleteMany({ modelId: { $in: orphanIds } })
        console.log(`  Removed ${orphans.length} orphaned models`)
      }

      console.log("\n✅ Sync complete!\n")
    }

    // Summary
    const activeCount = MODEL_DEFINITIONS.filter((m) => m.status === "active").length
    const disabledCount = MODEL_DEFINITIONS.filter((m) => m.status === "disabled").length

    console.log("📊 Summary:")
    console.log(`  Total models defined: ${MODEL_DEFINITIONS.length}`)
    console.log(`  Active: ${activeCount}`)
    console.log(`  Disabled: ${disabledCount}`)
    console.log(`  Inserted: ${toInsert.length}`)
    console.log(`  Updated: ${toUpdate.length}`)
    console.log(`  Unchanged: ${toKeep.length}`)
    if (orphans.length > 0) {
      console.log(`  Removed orphans: ${orphans.length}`)
    }

    // Provider breakdown
    console.log("\n📊 By Provider:")
    const providers = [...new Set(MODEL_DEFINITIONS.map((m) => m.provider))]
    for (const provider of providers) {
      const providerModels = MODEL_DEFINITIONS.filter((m) => m.provider === provider)
      const active = providerModels.filter((m) => m.status === "active").length
      const total = providerModels.length
      console.log(`  ${provider}: ${active}/${total} active`)
    }
  } catch (error) {
    console.error("Error syncing models:", error)
    throw error
  } finally {
    await mongoClient.close()
  }
}

// Run if called directly
if (import.meta.main) {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")

  syncModels(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

export { syncModels, MODEL_DEFINITIONS }
