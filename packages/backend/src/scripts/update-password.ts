/**
 * Update Password Script
 *
 * Updates the password for an existing user.
 *
 * Usage:
 *   npx tsx src/scripts/update-password.ts <email> <new-password>
 *
 * Examples:
 *   npx tsx src/scripts/update-password.ts admin@example.com newpassword123
 */

import * as bcrypt from 'bcrypt'
import { config as dotenvConfig } from 'dotenv'
import { MongoClient } from 'mongodb'

dotenvConfig()

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || 'teros'

function parseArgs(): { email: string; password: string } {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    console.error('Usage: npx tsx src/scripts/update-password.ts <email> <new-password>')
    console.error('')
    console.error('Example:')
    console.error('  npx tsx src/scripts/update-password.ts admin@example.com newpassword123')
    process.exit(1)
  }

  return { email: args[0], password: args[1] }
}

async function main() {
  const { email, password } = parseArgs()

  console.log('🔑 Update Password Script')
  console.log('=========================\n')

  if (password.length < 8) {
    console.error('❌ Password must be at least 8 characters')
    process.exit(1)
  }

  console.log(`Connecting to MongoDB: ${MONGODB_URI}`)
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db(MONGODB_DATABASE)
  console.log(`Connected to database: ${MONGODB_DATABASE}\n`)

  // Find user
  const user = await db.collection('users').findOne({
    'profile.email': email.toLowerCase(),
  })

  if (!user) {
    console.error(`❌ User not found: ${email}`)
    await client.close()
    process.exit(1)
  }

  console.log(`Found user: ${user.profile.displayName} (${user.userId})`)

  // Update password hash
  const passwordHash = await bcrypt.hash(password, 12)
  const now = new Date()

  const result = await db.collection('user_identities').updateOne(
    { userId: user.userId, type: 'password', status: 'active' },
    {
      $set: {
        'data.passwordHash': passwordHash,
        'data.failedAttempts': 0,
        'data.lastPasswordChangeAt': now,
        'data.lockedUntil': null,
        updatedAt: now,
      },
    },
  )

  if (result.matchedCount === 0) {
    console.error('❌ No password identity found for this user')
    await client.close()
    process.exit(1)
  }

  console.log('\n✅ Password updated successfully!')
  console.log(`   Email: ${email}`)

  await client.close()
}

main().catch((error) => {
  console.error('❌ Failed:', error)
  process.exit(1)
})
