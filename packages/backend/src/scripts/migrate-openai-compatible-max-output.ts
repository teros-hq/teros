/**
 * Migration: bump stored `models[].context.maxOutputTokens` on `openai-compatible`
 * providers whose stored value is the legacy 8192 default.
 *
 * Context: `buildOpenAICompatibleModel` previously defaulted `maxOutputTokens`
 * to 8192, which strangled reasoning_content on openai-compatible endpoints
 * that share the budget between content + reasoning (e.g. Qwopus via Tower).
 * The default was bumped to 32768 in provider-service.ts, but existing
 * `user_providers.models[]` records created before the bump still carry 8192.
 *
 * This migration patches those records in place. Safe to re-run (idempotent).
 *
 * Usage: tsx src/scripts/migrate-openai-compatible-max-output.ts [--apply]
 * Without --apply it's a dry-run.
 */
import { MongoClient } from "mongodb"

const LEGACY_DEFAULT = 8192
const NEW_DEFAULT = 32768

async function main() {
  const apply = process.argv.includes("--apply")
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017"
  const client = new MongoClient(mongoUri)
  await client.connect()
  const db = client.db("teros")

  const providers = await db
    .collection("user_providers")
    .find({ providerType: "openai-compatible" })
    .toArray()

  let totalProviders = 0
  let totalModelsPatched = 0

  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : []
    let patchedThisProvider = 0
    const patchedModels = models.map((m: any) => {
      if (m?.context?.maxOutputTokens === LEGACY_DEFAULT) {
        patchedThisProvider += 1
        return {
          ...m,
          context: {
            ...m.context,
            maxOutputTokens: NEW_DEFAULT,
          },
        }
      }
      return m
    })

    if (patchedThisProvider > 0) {
      totalProviders += 1
      totalModelsPatched += patchedThisProvider
      console.log(
        `[${apply ? "APPLY" : "DRY"}] provider=${provider.providerId} ` +
          `models_patched=${patchedThisProvider}/${models.length}`,
      )
      if (apply) {
        await db.collection("user_providers").updateOne(
          { providerId: provider.providerId },
          { $set: { models: patchedModels, updatedAt: new Date().toISOString() } },
        )
      }
    }
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY-RUN"}: ${totalProviders} providers, ${totalModelsPatched} models would be updated from ${LEGACY_DEFAULT} to ${NEW_DEFAULT}.`,
  )
  if (!apply) {
    console.log("Re-run with --apply to commit changes.")
  }

  await client.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
