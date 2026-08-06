#!/usr/bin/env bun
/**
 * Test New Models Script
 *
 * Tests the newly added model strings against OpenRouter and Anthropic APIs
 * to verify they are valid and accessible.
 *
 * Usage:
 *   bun run src/scripts/test-new-models.ts
 */

import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"
import { ProviderService } from "../services/provider-service"

const __filename_local = fileURLToPath(import.meta.url)
const __dirname_local = dirname(__filename_local)

// Models to test
const OPENROUTER_MODELS = [
  { modelId: "openrouter-claude-opus-4-7", modelString: "anthropic/claude-opus-4.7" },
  { modelId: "openrouter-claude-opus-4-8", modelString: "anthropic/claude-opus-4.8" },
  { modelId: "openrouter-claude-fable-5", modelString: "anthropic/claude-fable-5" },
  { modelId: "openrouter-gpt-5-5", modelString: "openai/gpt-5.5" },
  { modelId: "openrouter-gpt-5-5-pro", modelString: "openai/gpt-5.5-pro" },
  { modelId: "openrouter-qwen-3-7-max", modelString: "qwen/qwen3.7-max" },
  { modelId: "openrouter-deepseek-v4-pro", modelString: "deepseek/deepseek-v4-pro" },
  { modelId: "openrouter-gemini-3-5-flash", modelString: "google/gemini-3.5-flash" },
]

async function testOpenRouterModel(apiKey: string, modelString: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://teros.ai",
        "X-Title": "Teros Model Test",
      },
      body: JSON.stringify({
        model: modelString,
        messages: [{ role: "user", content: "Say 'OK' and nothing else." }],
        max_tokens: 10,
      }),
    })

    if (response.status === 200) {
      return { ok: true }
    }

    const errorData = await response.json().catch(() => ({})) as any
    const errorMessage = errorData.error?.message || errorData.message || `HTTP ${response.status}`
    return { ok: false, error: errorMessage }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

async function main() {
  console.log("🧪 Testing new model strings...\n")

  // Load secrets
  const secretsPath = join(__dirname_local, "../../../../.secrets")
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  // Connect to MongoDB
  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"

  const mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  const db = mongoClient.db(mongoDatabase)

  try {
    // Get OpenRouter provider and decrypt API key
    const providerService = new ProviderService(db)
    
    // Find OpenRouter provider - check system user first, then any user
    let openrouterProvider = null
    let providerUserId = ""
    
    for (const userId of ["system", "user_0000000000000000"]) {
      const providers = await providerService.listUserProviders(userId)
      openrouterProvider = providers.find(p => p.providerType === "openrouter")
      if (openrouterProvider) {
        providerUserId = userId
        break
      }
    }

    if (!openrouterProvider) {
      console.log("❌ No OpenRouter provider found")
      return
    }

    console.log(`📋 Found OpenRouter provider for user: ${providerUserId}, providerId: ${openrouterProvider.providerId}`)

    // Get decrypted secrets
    const providerSecrets = await providerService.getProviderSecrets(providerUserId, openrouterProvider.providerId)
    
    if (!providerSecrets) {
      console.log("❌ Failed to decrypt provider secrets")
      return
    }
    
    const apiKey = providerSecrets.apiKey

    if (!apiKey) {
      console.log("❌ No API key found for OpenRouter provider")
      return
    }

    console.log(`🔑 Using OpenRouter API key: ${apiKey.substring(0, 15)}...\n`)

    // Test each model
    console.log("Testing OpenRouter models:\n")
    const results: { modelId: string; modelString: string; ok: boolean; error?: string }[] = []

    for (const model of OPENROUTER_MODELS) {
      process.stdout.write(`  Testing ${model.modelId} (${model.modelString})... `)
      const result = await testOpenRouterModel(apiKey, model.modelString)
      results.push({ ...model, ...result })

      if (result.ok) {
        console.log("✅ OK")
      } else {
        console.log(`❌ ${result.error}`)
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500))
    }

    // Summary
    console.log("\n📊 Summary:")
    const passed = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok).length
    console.log(`  ✅ Passed: ${passed}`)
    console.log(`  ❌ Failed: ${failed}`)

    if (failed > 0) {
      console.log("\n❌ Failed models:")
      for (const r of results.filter(r => !r.ok)) {
        console.log(`  - ${r.modelId}: ${r.error}`)
      }
    }

  } finally {
    await mongoClient.close()
  }
}

main().catch(err => {
  console.error("Error:", err)
  process.exit(1)
})
