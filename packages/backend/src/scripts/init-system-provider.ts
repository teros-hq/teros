#!/usr/bin/env bun
/**
 * Initialize System Provider Script
 *
 * Creates a special "system" user with an LLM provider for internal services.
 * This provider is used by:
 * - InternalLLMService (channel auto-naming)
 * - AgentHandler (generating agent profiles)
 *
 * Usage:
 *   bun run src/scripts/init-system-provider.ts
 *   # or from root:
 *   npm run init:system-provider
 *
 * Environment Variables:
 *   SYSTEM_ANTHROPIC_API_KEY - API key for Anthropic (preferred)
 *   SYSTEM_OPENAI_API_KEY    - API key for OpenAI (alternative)
 *   MONGODB_URI              - MongoDB connection string
 *   MONGODB_DATABASE         - MongoDB database name
 */

import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"
import type { ProviderType } from "../services/provider-service"
import { ProviderService } from "../services/provider-service"

const __filename_local = fileURLToPath(import.meta.url)
const __dirname_local = dirname(__filename_local)

const SYSTEM_USER_ID = "system"

interface SystemProviderConfig {
  providerType: ProviderType
  apiKey: string
  displayName: string
}

/**
 * Determine which provider to use based on environment variables
 */
function getSystemProviderConfig(): SystemProviderConfig {
  // Check for OpenRouter (preferred - supports all models)
  if (process.env.SYSTEM_OPENROUTER_API_KEY) {
    return {
      providerType: "openrouter",
      apiKey: process.env.SYSTEM_OPENROUTER_API_KEY,
      displayName: "System (OpenRouter)",
    }
  }

  // Check for Anthropic
  if (process.env.SYSTEM_ANTHROPIC_API_KEY) {
    return {
      providerType: "anthropic",
      apiKey: process.env.SYSTEM_ANTHROPIC_API_KEY,
      displayName: "System (Anthropic)",
    }
  }

  // Check for OpenAI
  if (process.env.SYSTEM_OPENAI_API_KEY) {
    return {
      providerType: "openai",
      apiKey: process.env.SYSTEM_OPENAI_API_KEY,
      displayName: "System (OpenAI)",
    }
  }

  throw new Error(
    "No system provider configured. Please set one of:\n" +
      "  - SYSTEM_OPENROUTER_API_KEY (recommended - supports all models)\n" +
      "  - SYSTEM_ANTHROPIC_API_KEY\n" +
      "  - SYSTEM_OPENAI_API_KEY\n\n" +
      "Example:\n" +
      "  export SYSTEM_OPENROUTER_API_KEY=sk-or-v1-...\n" +
      "  bun run src/scripts/init-system-provider.ts",
  )
}

/**
 * Main initialization function
 */
async function initSystemProvider(): Promise<void> {
  console.log("🔧 Initializing System Provider...\n")

  // Load secrets (required for encryption)
  console.log("🔐 Loading secrets...")
  await secrets.load()
  console.log("✅ Secrets loaded\n")

  // Validate configuration
  const providerConfig = getSystemProviderConfig()

  console.log(`📋 Configuration:`)
  console.log(`   Provider Type: ${providerConfig.providerType}`)
  console.log(`   Display Name:  ${providerConfig.displayName}`)
  console.log(`   API Key:       ${providerConfig.apiKey.substring(0, 10)}...`)
  console.log("")

  // Load secrets and connect to MongoDB
  console.log("🔌 Connecting to MongoDB...")
  const secretsPath = join(__dirname_local, "../../../../.secrets")
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"

  const client = new MongoClient(mongoUri)

  try {
    await client.connect()
    const db = client.db(mongoDatabase)
    console.log("✅ Connected to MongoDB\n")

    const providerService = new ProviderService(db)

    // Check if system provider already exists
    console.log("🔍 Checking for existing system provider...")
    const existingProviders = await providerService.listUserProviders(SYSTEM_USER_ID)

    if (existingProviders.length > 0) {
      console.log("⚠️  System provider already exists:\n")
      existingProviders.forEach((p) => {
        console.log(`   Provider ID:   ${p.providerId}`)
        console.log(`   Type:          ${p.providerType}`)
        console.log(`   Display Name:  ${p.displayName}`)
        console.log(`   Status:        ${p.status}`)
        console.log(`   Models:        ${p.models.length} discovered`)
        console.log(`   Last Tested:   ${p.lastTestedAt || "never"}`)
        console.log("")
      })

      console.log("ℹ️  To recreate the provider, delete it first:")
      console.log(
        `   docker exec teros-mongodb mongosh ${mongoDatabase} --quiet --eval 'db.user_providers.deleteMany({userId: "system"})'`,
      )
      console.log("")

      await client.close()
      return
    }

    // Create the provider
    console.log("📦 Creating system provider...")
    const provider = await providerService.addProvider(SYSTEM_USER_ID, {
      providerType: providerConfig.providerType,
      displayName: providerConfig.displayName,
      auth: { apiKey: providerConfig.apiKey },
    })

    console.log("✅ System provider created:\n")
    console.log(`   Provider ID:   ${provider.providerId}`)
    console.log(`   Type:          ${provider.providerType}`)
    console.log(`   Display Name:  ${provider.displayName}`)
    console.log(`   Status:        ${provider.status}`)
    console.log("")

    // Test the provider to discover models
    console.log("🧪 Testing provider (discovering models)...")
    const testResult = await providerService.testProvider(provider.providerId)

    if (testResult.ok) {
      console.log("✅ Provider test successful!\n")
      console.log(`   Models discovered: ${testResult.models?.length || 0}`)

      if (testResult.models && testResult.models.length > 0) {
        console.log("")
        console.log("   Available models:")
        testResult.models.slice(0, 5).forEach((m) => {
          console.log(`   - ${m.modelId.padEnd(30)} (${m.modelString})`)
        })

        if (testResult.models.length > 5) {
          console.log(`   ... and ${testResult.models.length - 5} more`)
        }
      }

      console.log("")
      console.log("🎉 System provider initialized successfully!")
      console.log("")
      console.log("ℹ️  Internal services will now use this provider:")
      console.log("   - InternalLLMService (channel auto-naming)")
      console.log("   - AgentHandler (agent profile generation)")
      console.log("")
    } else {
      console.error("❌ Provider test failed:", testResult.error)
      console.error("")
      console.error("⚠️  The provider was created but is not working correctly.")
      console.error("   Please check your API key and try again.")
      console.error("")
      console.error("   To delete and recreate:")
      console.error(
        `   docker exec teros-mongodb mongosh ${mongoDatabase} --quiet --eval 'db.user_providers.deleteOne({providerId: "${provider.providerId}"})'`,
      )
      process.exit(1)
    }
  } catch (error) {
    console.error("❌ Error initializing system provider:", error)
    if (error instanceof Error) {
      console.error("   Message:", error.message)
    }
    process.exit(1)
  } finally {
    await client.close()
  }
}

// Run
initSystemProvider().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
