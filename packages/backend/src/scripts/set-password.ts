/**
 * Set Password Script
 *
 * Sets or updates the password for an existing user.
 * Works for users created via Google OAuth (adds a password identity)
 * or users who already have a password (updates the hash).
 *
 * Usage:
 *   npx ts-node src/scripts/set-password.ts <email> <password>
 *
 * Examples:
 *   npx ts-node src/scripts/set-password.ts pablo@example.agentapps.tech mypassword123
 */

import * as bcrypt from "bcrypt"
import { config as dotenvConfig } from "dotenv"
import { MongoClient } from "mongodb"

// Load environment
dotenvConfig()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "teros"

async function main() {
  const [email, password] = process.argv.slice(2)

  if (!email || !password) {
    console.error(
      "Usage: npx ts-node src/scripts/set-password.ts <email> <password>",
    )
    console.error("")
    console.error("Examples:")
    console.error(
      "  npx ts-node src/scripts/set-password.ts pablo@example.agentapps.tech mypassword123",
    )
    process.exit(1)
  }

  if (password.length < 8) {
    console.error("❌ Password must be at least 8 characters")
    process.exit(1)
  }

  const normalizedEmail = email.toLowerCase()

  console.log("🔑 Set Password Script")
  console.log("========================\n")

  // Connect to MongoDB
  console.log(`Connecting to MongoDB: ${MONGODB_URI}`)
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db(MONGODB_DATABASE)
  console.log(`Connected to database: ${MONGODB_DATABASE}\n`)

  // Find user by email
  const user = await db.collection("users").findOne({
    "profile.email": normalizedEmail,
  })

  if (!user) {
    console.error(`❌ User not found: ${normalizedEmail}`)
    await client.close()
    process.exit(1)
  }

  console.log("Found user:")
  console.log(`  userId: ${user.userId}`)
  console.log(`  email: ${user.profile.email}`)
  console.log(`  displayName: ${user.profile.displayName}`)
  console.log(`  role: ${user.role}`)

  // Hash the password
  console.log("\n🔄 Hashing password...")
  const passwordHash = await bcrypt.hash(password, 12)

  // Check if password identity already exists
  const existingIdentity = await db.collection("user_identities").findOne({
    type: "password",
    userId: user.userId,
  })

  const now = new Date()

  if (existingIdentity) {
    // Update existing password identity
    console.log("🔄 Updating existing password identity...")
    await db.collection("user_identities").updateOne(
      { type: "password", userId: user.userId },
      {
        $set: {
          "data.passwordHash": passwordHash,
          "data.failedAttempts": 0,
          "data.lastPasswordChangeAt": now,
          updatedAt: now,
        },
      },
    )
    console.log("✅ Password updated")
  } else {
    // Create new password identity
    console.log("🔄 Creating password identity (user had no password)...")
    const identity = {
      userId: user.userId,
      type: "password",
      providerUserId: normalizedEmail,
      email: normalizedEmail,
      data: {
        passwordHash,
        failedAttempts: 0,
        lastPasswordChangeAt: now,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
    }

    await db.collection("user_identities").insertOne(identity)
    console.log("✅ Password identity created")
  }

  // Show all identities for this user
  const identities = await db
    .collection("user_identities")
    .find({ userId: user.userId })
    .toArray()

  console.log(`\n📋 User identities (${identities.length}):`)
  for (const id of identities) {
    console.log(`  - ${id.type}: ${id.providerUserId}`)
  }

  console.log("\n✅ Done!")
  console.log(`\nLogin credentials:`)
  console.log(`   Email: ${normalizedEmail}`)
  console.log(`   Password: ${"*".repeat(password.length)}`)

  await client.close()
}

main().catch((error) => {
  console.error("❌ Failed:", error)
  process.exit(1)
})
