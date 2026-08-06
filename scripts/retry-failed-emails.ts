/**
 * Retry failed emails from email_audit_log
 *
 * Finds audit log entries whose last attempt was a failure and re-sends them.
 * Each retry is recorded as a new attempt in the existing audit document.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/retry-failed-emails.ts [options]
 *
 * Options:
 *   --dry-run     Show what would be retried without sending
 *   --limit N     Max number of emails to retry (default: all)
 *
 * Examples:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/retry-failed-emails.ts --dry-run
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/retry-failed-emails.ts --limit 5
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { config as dotenvConfig } from "dotenv"
import { MongoClient } from "mongodb"
import type { EmailAuditLog } from "../packages/backend/src/services/email-service"
import { EmailService } from "../packages/backend/src/services/email-service"

dotenvConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const limitIndex = args.indexOf("--limit")
const limit = limitIndex !== -1 ? Number.parseInt(args[limitIndex + 1], 10) : 0

if (limitIndex !== -1 && (Number.isNaN(limit) || limit <= 0)) {
  console.error("--limit requires a positive integer")
  process.exit(1)
}

const secretsPath = path.join(__dirname, "../.secrets/system/email.json")
if (!fs.existsSync(secretsPath)) {
  console.error("Missing .secrets/system/email.json — cannot send email")
  process.exit(1)
}
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"))
if (!secrets.resendApiKey) {
  console.error("resendApiKey not found in .secrets/system/email.json")
  process.exit(1)
}

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"

async function main() {
  const mongoClient = new MongoClient(MONGO_URI)
  await mongoClient.connect()
  const db = mongoClient.db(DB_NAME)

  try {
    const collection = db.collection<EmailAuditLog>("email_audit_log")

    const pipeline: object[] = [
      { $addFields: { lastAttempt: { $arrayElemAt: ["$attempts", -1] } } },
      { $match: { "lastAttempt.success": false } },
      { $sort: { "lastAttempt.sentAt": 1 } },
    ]

    if (limit > 0) {
      pipeline.push({ $limit: limit })
    }

    const failedEmails = await collection.aggregate<EmailAuditLog & { lastAttempt: EmailAuditLog["attempts"][0] }>(pipeline).toArray()

    if (failedEmails.length === 0) {
      console.log("No failed emails to retry.")
      return
    }

    console.log(`Found ${failedEmails.length} failed email(s) to retry${dryRun ? " (dry run)" : ""}:\n`)

    for (const doc of failedEmails) {
      const attemptCount = doc.attempts.length
      const lastError = doc.lastAttempt.error ?? "unknown"
      console.log(`  ${doc.to} | ${doc.template} | ${attemptCount} attempt(s) | last error: ${lastError}`)
    }

    if (dryRun) {
      console.log("\nDry run — no emails sent.")
      return
    }

    console.log("")

    const emailService = new EmailService(secrets.resendApiKey, { db })

    let succeeded = 0
    let failed = 0

    for (const doc of failedEmails) {
      process.stdout.write(`Retrying ${doc.to} (${doc.template})... `)

      const result = await emailService.send({
        to: doc.to,
        subject: doc.subject,
        template: doc.template,
        variables: doc.variables,
      })

      if (result.success) {
        console.log(`OK (${result.messageId})`)
        succeeded++
      } else {
        console.log(`FAILED (${result.error})`)
        failed++
      }
    }

    console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`)
  } finally {
    await mongoClient.close()
  }
}

main()
