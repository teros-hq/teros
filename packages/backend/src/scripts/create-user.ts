/**
 * Create User Script
 *
 * Creates a new user with password authentication.
 * Can optionally set a role and migrate existing data from another userId.
 *
 * Usage:
 *   npx tsx src/scripts/create-user.ts <email> <password> [displayName] [--role <role>] [--migrate-from <oldUserId>]
 *
 * Examples:
 *   npx tsx src/scripts/create-user.ts user@example.com mypassword123
 *   npx tsx src/scripts/create-user.ts user@example.com mypassword123 Alice
 *   npx tsx src/scripts/create-user.ts admin@example.com password123 Admin --role admin
 *   npx tsx src/scripts/create-user.ts user@example.com password123 Alice --migrate-from user:old-id
 */

import { generateUserId } from "@teros/core"
import * as bcrypt from "bcrypt"
import { config as dotenvConfig } from "dotenv"
import { type Db, MongoClient } from "mongodb"

// Load environment
dotenvConfig()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "teros"

function getSafeMongoUri(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.username || url.password) {
      return `${url.protocol}//${url.host}${url.pathname}`
    }
    return uri
  } catch {
    return '(invalid uri)'
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): {
  email: string
  password: string
  displayName: string
  role: string
  migrateFrom?: string
} {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    console.error(
      "Usage: npx tsx src/scripts/create-user.ts <email> <password> [displayName] [--role <role>] [--migrate-from <oldUserId>]",
    )
    console.error("")
    console.error("Examples:")
    console.error("  npx tsx src/scripts/create-user.ts user@example.com mypassword123")
    console.error("  npx tsx src/scripts/create-user.ts user@example.com mypassword123 Alice")
    console.error("  npx tsx src/scripts/create-user.ts admin@example.com password123 Admin --role admin")
    console.error(
      "  npx tsx src/scripts/create-user.ts user@example.com password123 Alice --migrate-from user:old-id",
    )
    process.exit(1)
  }

  const email = args[0]
  const password = args[1]
  let displayName = email.split("@")[0] // Default: use email prefix
  let role = "user"
  let migrateFrom: string | undefined

  // Parse remaining args
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--migrate-from" && args[i + 1]) {
      migrateFrom = args[i + 1]
      i++ // Skip next arg
    } else if (args[i] === "--role" && args[i + 1]) {
      role = args[i + 1]
      i++ // Skip next arg
    } else if (!args[i].startsWith("--")) {
      displayName = args[i]
    }
  }

  const validRoles = ["user", "admin", "super"]
  if (!validRoles.includes(role)) {
    console.error(`❌ Invalid role "${role}". Valid roles: ${validRoles.join(", ")}`)
    process.exit(1)
  }

  return { email, password, displayName, role, migrateFrom }
}

/**
 * Collections that may contain userId references
 */
const COLLECTIONS_WITH_USER_ID = [
  "channels",
  "messages",
  "sessions",
  "todos",
  "reminders",
  "recurring_tasks",
]

/**
 * Migrate data from old userId to new userId
 */
async function migrateUserData(db: Db, oldUserId: string, newUserId: string): Promise<void> {
  console.log(`\n🔄 Migrating data from ${oldUserId} to ${newUserId}...`)

  for (const collectionName of COLLECTIONS_WITH_USER_ID) {
    try {
      const collection = db.collection(collectionName)

      // Check if collection exists and has documents with old userId
      const count = await collection.countDocuments({ userId: oldUserId })

      if (count > 0) {
        const result = await collection.updateMany(
          { userId: oldUserId },
          { $set: { userId: newUserId } },
        )
        console.log(`   ${collectionName}: ${result.modifiedCount} documents migrated`)
      }
    } catch (error) {
      // Collection might not exist, that's ok
      console.log(`   ${collectionName}: skipped (not found or empty)`)
    }
  }

  // Also check for ownerId in agents collection
  try {
    const agentsCollection = db.collection("agents")
    const agentResult = await agentsCollection.updateMany(
      { ownerId: oldUserId },
      { $set: { ownerId: newUserId } },
    )
    if (agentResult.modifiedCount > 0) {
      console.log(`   agents (ownerId): ${agentResult.modifiedCount} documents migrated`)
    }
  } catch (error) {
    // Ignore
  }
}

async function main() {
  const { email, password, displayName, role, migrateFrom } = parseArgs()

  console.log("👤 Create User Script")
  console.log("=====================\n")

  // Validate password
  if (password.length < 8) {
    console.error("❌ Password must be at least 8 characters")
    process.exit(1)
  }

  // Connect to MongoDB
  console.log(`Connecting to MongoDB: ${getSafeMongoUri(MONGODB_URI)}`)
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db(MONGODB_DATABASE)
  console.log(`Connected to database: ${MONGODB_DATABASE}\n`)

  // Check if email already exists
  const existingUser = await db.collection("users").findOne({
    "profile.email": email.toLowerCase(),
  })

  if (existingUser) {
    console.log("⚠️  User with this email already exists!")
    console.log(`   userId: ${existingUser.userId}`)
    console.log(`   email: ${existingUser.profile.email}`)
    console.log(`   displayName: ${existingUser.profile.displayName}`)
    await client.close()
    process.exit(1)
  }

  // Generate new userId
  const userId = generateUserId()

  console.log("Creating user:")
  console.log(`  userId: ${userId}`)
  console.log(`  email: ${email}`)
  console.log(`  displayName: ${displayName}`)
  console.log(`  role: ${role}`)
  console.log(`  password: ${"*".repeat(password.length)}`)
  if (migrateFrom) {
    console.log(`  migrateFrom: ${migrateFrom}`)
  }

  // Create user
  console.log("\n🔄 Creating user...")
  const now = new Date()
  const user = {
    userId,
    profile: {
      displayName,
      email: email.toLowerCase(),
    },
    status: "active",
    role,
    emailVerified: true,
    accessGranted: true,
    availableInvitations: 3,
    createdAt: now,
    updatedAt: now,
  }

  await db.collection("users").insertOne(user)
  console.log("✅ User created")

  // Create password identity
  console.log("🔄 Creating password identity...")
  const passwordHash = await bcrypt.hash(password, 12)

  const identity = {
    userId,
    type: "password",
    providerUserId: email.toLowerCase(),
    email: email.toLowerCase(),
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

  // Ensure indexes
  console.log("🔄 Ensuring indexes...")
  await db.collection("users").createIndex({ userId: 1 }, { unique: true })
  await db.collection("users").createIndex({ "profile.email": 1 }, { unique: true })
  await db
    .collection("user_identities")
    .createIndex({ type: 1, providerUserId: 1 }, { unique: true })
  await db.collection("user_identities").createIndex({ userId: 1 })
  console.log("✅ Indexes created")

  // Migrate data if requested
  if (migrateFrom) {
    await migrateUserData(db, migrateFrom, userId)
  }

  // Show final stats
  console.log("\n📊 User data:")
  for (const collectionName of COLLECTIONS_WITH_USER_ID) {
    try {
      const count = await db.collection(collectionName).countDocuments({ userId })
      if (count > 0) {
        console.log(`   ${collectionName}: ${count}`)
      }
    } catch (error) {
      // Ignore
    }
  }

  console.log("\n✅ User created successfully!")
  console.log(`\nLogin credentials:`)
  console.log(`   Email: ${email}`)
  console.log(`   Password: ${"*".repeat(password.length)}`)
  console.log(`   userId: ${userId}`)

  await client.close()
}

main().catch((error) => {
  console.error("❌ Failed:", error)
  process.exit(1)
})
