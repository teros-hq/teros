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
import { getSchemaWriteMode, withSchemaValidation } from './db/validated'
import { captureException, flush as flushSentry, initSentry } from './lib/sentry'
import { createLogger } from './lib/logger'
import { SecretsManager, secrets } from './secrets/secrets-manager'
import { bootstrapServer } from './bootstrap'

const log = createLogger('Bootstrap')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function main() {
  log.info('Teros Backend starting...')

  // -------------------------------------------------------------------------
  // SENTRY ERROR TRACKING
  // -------------------------------------------------------------------------
  initSentry({
    environment: process.env.NODE_ENV || 'production',
  })

  // -------------------------------------------------------------------------
  // SECRETS
  // -------------------------------------------------------------------------

  log.info('Loading secrets...')
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
    log.error('Missing required secrets:')
    missingSecrets.forEach((s) => log.error({ secret: s }, `  - ${s}`))
    log.error('See .secrets/system/*.example.json for reference.')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // DATABASE
  // Priority: env var (for Docker/infra overrides) > SecretsManager > defaults
  // -------------------------------------------------------------------------

  log.info('Connecting to MongoDB...')
  const dbSecret = secretsManager.system('database')
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || 'mongodb://localhost:27017'
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || 'teros'
  // serverSelectionTimeoutMS caps how long an op waits for a reachable server
  // (default 30s). 5s lets the shutdown flush fail fast to the dead-letter within
  // PM2's kill_timeout when Mongo is down, instead of stacking 30s waits (A1.9).
  const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
  await mongoClient.connect()
  // Collections with a document schema (src/db/schemas.ts) validate reads
  // (warn and continue) and writes (DB_SCHEMA_WRITES: warn | error) — GOV-2
  const db = withSchemaValidation(mongoClient.db(mongoDatabase))
  log.info({ database: mongoDatabase, schemaWrites: getSchemaWriteMode() }, 'MongoDB connected')

  // -------------------------------------------------------------------------
  // AUTH SETUP
  // -------------------------------------------------------------------------

  const authManager = new AuthManager(db)
  log.info('AuthManager initialized')

  const mcaOAuth = initMcaOAuth(db, authManager, secretsManager)

  // REQ-11: Initialize per-user auth service for personal apps
  // (its indexes are applied in bootstrapServer, after migrations — GOV-4)

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
  log.fatal({ err: error }, 'Fatal error in main()')
  captureException(error, { context: 'main' })
  await flushSentry(2000)
  process.exit(1)
})

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  // Log the FULL stack explicitly: pino serializes Error objects as
  // {type, message} without .stack by default, which made RangeErrors
  // ("Maximum call stack size exceeded") impossible to locate from logs
  // (incident task_9489fb0ae1682990, 2026-10-22).
  const stack = reason instanceof Error ? reason.stack : String(reason)
  log.error(
    {
      err: reason instanceof Error ? reason : new Error(String(reason)),
      stack,
      promiseTag: typeof (promise as any)?.tag === 'string' ? (promise as any).tag : undefined,
    },
    'Unhandled Rejection',
  )
  captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    context: 'unhandledRejection',
  })
})

// Global uncaught exception handler
process.on('uncaughtException', async (error) => {
  log.fatal({ err: error }, 'Uncaught Exception')
  captureException(error, { context: 'uncaughtException' })
  await flushSentry(2000)
  process.exit(1)
})
