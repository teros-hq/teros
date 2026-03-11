/**
 * Test script — sends welcome-founding-partner email via Resend
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/test-email.ts <email>
 *
 * Example:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/test-email.ts pablo@teros.ai
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { Resend } from "resend"
import { config as dotenvConfig } from "dotenv"

dotenvConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const email = process.argv[2]
if (!email) {
  console.error("Usage: test-email.ts <email>")
  process.exit(1)
}

// Load API key from secrets file
const secretsPath = path.join(__dirname, "../.secrets/system/email.json")
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"))
if (!secrets.resendApiKey) throw new Error("resendApiKey not found in .secrets/system/email.json")

const STATIC_BASE_URL = process.env.STATIC_BASE_URL || "http://localhost:3000/static"
const TEMPLATES = path.join(__dirname, "../packages/backend/templates/emails")

// Load template
let html = fs.readFileSync(path.join(TEMPLATES, "welcome-founding-partner.html"), "utf-8")
html = html.replace(/{{STATIC_BASE_URL}}/g, STATIC_BASE_URL)
html = html.replace(/{{USER_NAME}}/g, email.split("@")[0])

async function main() {
  const resend = new Resend(secrets.resendApiKey)

  console.log(`Sending welcome-founding-partner to ${email}...`)

  const { data, error } = await resend.emails.send({
    from: "Teros <hello@teros.ai>",
    to: email,
    subject: "You're in. Welcome to the beginning.",
    html,
  })

  if (error) {
    console.error("❌ Error:", error)
    process.exit(1)
  } else {
    console.log("✅ Email sent! Message ID:", data?.id)
  }
}

main()
