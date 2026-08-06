/**
 * Invite a Founding Partner
 *
 * - Grants platform access
 * - Adds "founding_partner" to badges array
 * - Sends the welcome-founding-partner email
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/invite-founding-partner.ts <email>
 *
 * Example:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/invite-founding-partner.ts john@example.com
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { config as dotenvConfig } from "dotenv"
import { MongoClient } from "mongodb"
import { EmailService } from "../packages/backend/src/services/email-service"

dotenvConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const email = process.argv[2]
if (!email) {
  console.error("Usage: invite-founding-partner.ts <email>")
  process.exit(1)
}

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"
const secretsPath = path.join(__dirname, "../.secrets/system/email.json")
if (!fs.existsSync(secretsPath)) {
  console.error("❌ Missing .secrets/system/email.json — cannot send email")
  process.exit(1)
}
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"))
if (!secrets.resendApiKey) {
  console.error("❌ resendApiKey not found in .secrets/system/email.json")
  process.exit(1)
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

    // Grant access + add founding_partner badge
    await db.collection("users").updateOne(
      { userId: user.userId },
      { $set: { accessGranted: true, updatedAt: new Date() }, $addToSet: { badges: "founding_partner" } }
    )
    console.log("✅ Access granted, founding_partner badge added")

    // Send founding partner email
    const emailService = new EmailService(secrets.resendApiKey, { db })
    const result = await emailService.sendWelcomeFoundingPartner(email, {USER_NAME: user.profile.displayName})

    if (!result.success) console.error("❌ Email error:", result.error)
    else console.log(`✅ Founding partner email sent — ID: ${result.messageId}`)
  } finally {
    await client.close()
  }
}

main()
