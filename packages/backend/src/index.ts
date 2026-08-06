/**
 * Teros Backend — Entry Point
 *
 * Thin bootstrap: loads secrets, connects to MongoDB, then delegates all
 * server initialisation to bootstrap/server-bootstrap.ts.
 *
 * LLM configuration is dynamic per agent:
 * - Models are defined in the 'models' collection
 * - Agent cores reference models and can override defaults
 * - MessageHandler creates LLM clients dynamically based on agent config
 */

import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { MongoClient } from 'mongodb'

import { AuthManager } from './auth/auth-manager'
import { initMcaOAuth } from './auth/mca-oauth'
import { config } from './config'
import { createContainer } from './container'
import { captureException, flush as flushSentry, initSentry } from './lib/sentry'
import { SecretsManager, secrets } from './secrets/secrets-manager'
import { bootstrapServer } from './bootstrap'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function main() {
  console.log('Teros Backend starting...')

  // -------------------------------------------------------------------------
  // SENTRY ERROR TRACKING
  // -------------------------------------------------------------------------
  initSentry({
    environment: process.env.NODE_ENV || 'development',
  })

  // -------------------------------------------------------------------------
  // SECRETS
  // -------------------------------------------------------------------------

  console.log('Loading secrets...')
  const secretsPath = join(__dirname, '../../../.secrets')
  process.env.SECRETS_PATH = secretsPath

  const secretsManager = new SecretsManager(secretsPath)
  await secretsManager.load()

  // Also load singleton secrets instance
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  // -------------------------------------------------------------------------
  // REQUIRED SECRETS VALIDATION
  // Fail fast with a clear message if critical secrets are missing
  // -------------------------------------------------------------------------

  const missingSecrets: string[] = []
  if (!secretsManager.hasSystem('encryption')) {
    missingSecrets.push(
      '.secrets/system/encryption.json (required for encrypting user credentials)',
    )
  }
  if (missingSecrets.length > 0) {
    console.error('❌ Missing required secrets:')
    missingSecrets.forEach((s) => console.error(`   - ${s}`))
    console.error('\nSee .secrets/system/*.example.json for reference.')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // DATABASE
  // Priority: env var (for Docker/infra overrides) > SecretsManager > defaults
  // -------------------------------------------------------------------------

  console.log('Connecting to MongoDB...')
  const dbSecret = secretsManager.system('database')
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || 'mongodb://localhost:27017'
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || 'teros'
  // serverSelectionTimeoutMS caps how long an op waits for a reachable server
  // (default 30s). 5s lets the shutdown flush fail fast to the dead-letter within
  // PM2's kill_timeout when Mongo is down, instead of stacking 30s waits (A1.9).
  const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
  await mongoClient.connect()
  const db = mongoClient.db(mongoDatabase)
  console.log(`MongoDB connected (${mongoDatabase})`)

  // -------------------------------------------------------------------------
  // AUTH SETUP
  // -------------------------------------------------------------------------

  const authManager = new AuthManager(db)
  console.log('AuthManager initialized')

  const mcaOAuth = initMcaOAuth(db, authManager, secretsManager)

  // -------------------------------------------------------------------------
  // BOOTSTRAP SERVER
  // -------------------------------------------------------------------------

  const container = createContainer()

  await bootstrapServer({
    container,
    db,
    mongoClient,
    secretsManager,
    authManager,
    mcaOAuth,
  })
}

main().catch(async (error) => {
  console.error('Fatal error:', error)
  captureException(error, { context: 'main' })
  await flushSentry(2000)
  process.exit(1)
})

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    context: 'unhandledRejection',
  })
})

// Global uncaught exception handler
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error)
  captureException(error, { context: 'uncaughtException' })
  await flushSentry(2000)
  process.exit(1)
})
