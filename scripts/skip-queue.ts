/**
 * Skip the Queue
 *
 * Grants platform access to a user without needing 3 invitations.
 * Sends the access-granted email.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/skip-queue.ts <email>
 *
 * Example:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/skip-queue.ts john@example.com
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { MongoClient } from "mongodb"
import { Resend } from "resend"
import { config as dotenvConfig } from "dotenv"

dotenvConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const email = process.argv[2]
if (!email) {
  console.error("Usage: skip-queue.ts <email>")
  process.exit(1)
}

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const STATIC_BASE_URL = process.env.STATIC_BASE_URL || "http://localhost:3000/static"
const TEMPLATES = path.join(__dirname, "../packages/backend/templates/emails")
const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, "../.secrets/system/email.json"), "utf-8"))
if (!secrets.resendApiKey) throw new Error("resendApiKey not found in .secrets/system/email.json")

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const db = client.db("teros")

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

    // Grant access (keep availableInvitations at 0 until they earn it)
    await db.collection("users").updateOne(
      { userId: user.userId },
      { $set: { accessGranted: true, updatedAt: new Date() } }
    )
    console.log("✅ Access granted")

    // Send access-granted email
    let html = fs.readFileSync(path.join(TEMPLATES, "access-granted.html"), "utf-8")
    html = html
      .replace(/{{STATIC_BASE_URL}}/g, STATIC_BASE_URL)
      .replace(/{{USER_NAME}}/g, user.profile.displayName)

    const resend = new Resend(secrets.resendApiKey)
    const { data, error } = await resend.emails.send({
      from: "Teros <hello@teros.ai>",
      to: email,
      subject: "You're in. Welcome to Teros.",
      html,
    })

    if (error) console.error("❌ Email error:", error)
    else console.log(`✅ Access granted email sent — ID: ${data?.id}`)

  } finally {
    await client.close()
  }
}

main()
