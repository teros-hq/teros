/**
 * Dev Seed Script — a functional dev@teros.local in a LOCAL database.
 *
 * Usage (repo root):
 *   MONGODB_DATABASE=<db> yarn dev:seed            # create / top up
 *   RESET=1 MONGODB_DATABASE=<db> yarn dev:seed    # wipe the dev user's data, recreate
 *
 * Env:
 *   MONGODB_DATABASE   required, from the shell (never taken from .env or secrets)
 *   MONGO_URI | MONGODB_URI   default mongodb://localhost:27017; must be a local host
 *   DEV_SEED_PROVIDER_KEY     LLM key so the agents answer (never printed)
 *   DEV_SEED_PROVIDER_TYPE / _NAME / _BASE_URL / _MODEL   default openai-compatible,
 *                             NaN Builders, https://api.nan.builders/v1, qwen3.6
 *
 * What it creates: src/services/dev-seed.ts. A backend booted with
 * TEROS_DEV_AUTOLOGIN=1 runs the same seed by itself when the user is missing.
 */

// Read before anything imports ../config, which loads .env into process.env
const SHELL_DATABASE = process.env.MONGODB_DATABASE?.trim()
const SHELL_URI =
  (process.env.MONGO_URI || process.env.MONGODB_URI)?.trim() || "mongodb://localhost:27017"
const RESET = process.env.RESET === "1"

/** Hosts of a mongodb:// URI (credentials dropped); null for anything else. */
function mongoHosts(uri: string): string[] | null {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)
  if (!match) return null
  return match[1]
    .split(",")
    .map((h) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]))
}

function fail(message: string): never {
  console.error(`[dev-seed] ${message}`)
  process.exit(1)
}

async function main() {
  const { join, dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const { isLocalHost } = await import("../auth/dev-autologin")

  if (process.env.NODE_ENV === "production") fail("refusing to run with NODE_ENV=production")
  if (!SHELL_DATABASE)
    fail("set MONGODB_DATABASE explicitly, e.g. MONGODB_DATABASE=teros_dev yarn dev:seed")
  const hosts = mongoHosts(SHELL_URI)
  if (!hosts?.every(isLocalHost))
    fail("refusing a non-local MongoDB (only localhost / private addresses)")

  const { MongoClient } = await import("mongodb")
  const { withSchemaValidation } = await import("../db/validated")
  const { secrets } = await import("../secrets/secrets-manager")
  const { seedDevUser, DEV_SEED_EMAIL, DEV_SEED_PASSWORD } = await import("../services/dev-seed")

  // Provider keys are encrypted with the system key (.secrets/system/encryption.json)
  const here = dirname(fileURLToPath(import.meta.url))
  ;(secrets as unknown as { basePath: string }).basePath = join(here, "../../../../.secrets")
  await secrets.load()

  console.log(
    `[dev-seed] ${RESET ? "Resetting and seeding" : "Seeding"} ${DEV_SEED_EMAIL} into ${hosts.join(",")}/${SHELL_DATABASE}`,
  )
  const client = new MongoClient(SHELL_URI, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  try {
    const report = await seedDevUser(withSchemaValidation(client.db(SHELL_DATABASE)), {
      reset: RESET,
    })
    console.log(
      `[dev-seed] ${report.createdUser ? "created" : "up to date"}: ${report.workspaces} workspaces, ` +
        `${report.agents} agents, ${report.apps} apps, ${report.tasks} tasks, ${report.conversations} conversations, ` +
        `provider ${report.provider}`,
    )
    console.log(
      `[dev-seed] login: ${DEV_SEED_EMAIL} / ${DEV_SEED_PASSWORD} (or TEROS_DEV_AUTOLOGIN=1)`,
    )
  } finally {
    await client.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[dev-seed] failed:", err)
    process.exit(1)
  })
