/**
 * Test script — sends welcome-founding-partner email via Resend
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/test-email.ts <email>
 *
 * Example:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/test-email.ts alice@example.com
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
  console.error("Usage: test-email.ts <email>")
  process.exit(1)
}

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

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"

async function main() {
  const mongoClient = new MongoClient(MONGO_URI)
  await mongoClient.connect()
  const db = mongoClient.db(DB_NAME)

  try {
    const emailService = new EmailService(secrets.resendApiKey, { db })

    console.log(`Sending welcome-founding-partner to ${email}...`)

    const result = await emailService.sendWelcomeFoundingPartner(email, {
      USER_NAME: email.split("@")[0],
    })

    if (!result.success) {
      console.error("❌ Error:", result.error)
      process.exit(1)
    } else {
      console.log("✅ Email sent! Message ID:", result.messageId)
    }
  } finally {
    await mongoClient.close()
  }
}

main()
