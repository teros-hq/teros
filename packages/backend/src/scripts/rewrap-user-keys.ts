/**
 * Re-wrap user encryption keys with the current system key (GOV-7 rotation).
 *
 * Rotation: add the new key to the `encryption` system secret as
 *   { "masterKey": "<v1 hex>", "keys": { "2": "<new hex>" }, "currentVersion": 2 }
 * deploy, run this script, then the old version can be removed from the secret
 * once every key reports keyVersion 2. User data never needs re-encrypting:
 * only the per-user master keys are re-wrapped.
 *
 * Usage:
 *   npx tsx src/scripts/rewrap-user-keys.ts
 */

import { join } from "node:path"
import { config as dotenvConfig } from "dotenv"
import { MongoClient } from "mongodb"
import { rewrapUserKeys } from "../auth/user-keys"
import { secrets } from "../secrets/secrets-manager"

dotenvConfig()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "teros"

async function main() {
  ;(secrets as unknown as { basePath: string }).basePath = join(__dirname, "../../../../.secrets")
  await secrets.load()

  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  try {
    const n = await rewrapUserKeys(client.db(MONGODB_DATABASE))
    console.log(`Re-wrapped ${n} user key(s) with the current system key version`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
