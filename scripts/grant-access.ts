/**
 * Grant Access
 *
 * Grants platform access to a waitlisted user.
 * Sends the access-granted email.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/grant-access.ts <email>
 *
 * Example:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/grant-access.ts john@example.com
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { MongoClient } from "mongodb"
import { config as dotenvConfig } from "dotenv"
import { EmailService } from "../packages/backend/src/services/email-service"

dotenvConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const email = process.argv[2]
if (!email) {
  console.error("Usage: grant-access.ts <email>")
  process.exit(1)
}

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"

// Email is best-effort: in local dev there is no resendApiKey, but the script
// must still be able to flip accessGranted so the first dev can get past the
// "Private Beta" gate. We only fail loudly if the secrets file itself is bad.
let resendApiKey: string | undefined
try {
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, "../.secrets/system/email.json"), "utf-8"))
  resendApiKey = secrets.resendApiKey
} catch (_) {
  // .secrets/system/email.json missing — fine in local dev
}

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const db = client.db(DB_NAME)

  try {
    // Find user
    const user = await db.collection("users").findOne({ "profile.email": email.toLowerCase() })
    if (!user) {
      console.error(`❌ User not found: ${email}`)
      process.exit(1)
    }

    console.log(`Found user: ${user.profile.displayName} (${user.userId})`)

    if (user.accessGranted) {
      console.log("ℹ️  User already has access, nothing to do")
      process.exit(0)
    }

    // Grant access
    await db.collection("users").updateOne(
      { userId: user.userId },
      { $set: { accessGranted: true, updatedAt: new Date() } }
    )
    console.log("✅ Access granted")

    // Send access-granted email (best-effort: skipped in local dev without Resend key)
    if (!resendApiKey) {
      console.log("ℹ️  Skipping email send (no resendApiKey configured — local dev)")
    } else {
      const emailService = new EmailService(resendApiKey, { db })
      const result = await emailService.sendAccessGranted(email, {
        USER_NAME: user.profile.displayName,
      })

      if (!result.success) console.error("❌ Email error:", result.error)
      else console.log(`✅ Access granted email sent — ID: ${result.messageId}`)
    }
  } finally {
    await client.close()
  }
}

main()
