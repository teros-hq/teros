#!/usr/bin/env bun
/**
 * Test script to verify Claude credentials (API key, OAuth, Claude Code CLI)
 *
 * Usage:
 *   bun src/scripts/test-claude-code-credentials.ts
 *
 * Or with yarn:
 *   yarn workspace @teros/backend oauth:status
 */

import { CLAUDE_4_5, LLMClientFactory } from "@teros/core"

async function main() {
  console.log("🔍 Claude Credentials Status\n")
  console.log("=".repeat(50))

  // Check what credentials are available
  const creds = LLMClientFactory.hasCredentials()

  console.log("\n📋 Available Credentials:\n")
  console.log(`   OAuth tokens:           ${creds.oauth ? "✅ Found" : "❌ Not found"}`)
  console.log(`   Claude Code CLI:        ${creds.claudeCode ? "✅ Found" : "❌ Not found"}`)

  // Get detailed info
  const info = await LLMClientFactory.getCredentialsInfo()

  console.log("\n📊 Detailed Status:\n")

  if (info.oauth) {
    console.log("   OAuth Tokens:")
    console.log(`     - Expired: ${info.oauth.isExpired ? "⚠️ Yes" : "✅ No"}`)
    if (info.oauth.expiresAt) {
      console.log(`     - Expires: ${info.oauth.expiresAt.toISOString()}`)
    }
  }

  if (info.claudeCode) {
    console.log("   Claude Code CLI:")
    console.log(`     - Expired: ${info.claudeCode.isExpired ? "⚠️ Yes" : "✅ No"}`)
    if (info.claudeCode.expiresAt) {
      console.log(`     - Expires: ${info.claudeCode.expiresAt.toISOString()}`)
    }
  }

  console.log("\n🎯 Recommended Provider:\n")
  if (info.recommended) {
    console.log(`   provider: '${info.recommended}'`)
  } else {
    console.log("   ❌ No credentials available!")
    console.log("\n   To set up credentials, choose one option:")
    console.log("")
    console.log("   Option 1: System Secret")
    console.log('     Add key to .secrets/system/anthropic.json: { "apiKey": "sk-ant-..." }')
    console.log("")
    console.log("   Option 2: Claude Max OAuth")
    console.log("     yarn workspace @teros/backend oauth:login")
    console.log("")
    console.log("   Option 3: Claude Code CLI")
    console.log("     npm install -g @anthropic-ai/claude-code")
    console.log("     claude auth login")
    console.log("")
    return
  }

  // Try creating a client
  console.log("\n🧪 Testing Client Creation:\n")

  try {
    const client = await LLMClientFactory.create({
      provider: info.recommended,
      anthropic: {
        model: CLAUDE_4_5.SONNET,
      },
    })

    const providerInfo = client.getProviderInfo()
    console.log(`   ✅ Client created successfully!`)
    console.log(`   - Provider: ${providerInfo.name}`)
    console.log(`   - Model: ${providerInfo.model}`)
    console.log(`   - Capabilities: ${JSON.stringify(providerInfo.capabilities)}`)
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`)
  }

  // Show usage example
  console.log("\n📝 Usage Example:\n")
  console.log("   ```typescript")
  console.log(`   import { LLMClientFactory, CLAUDE_4_5 } from '@teros/core'`)
  console.log("")
  console.log("   const client = await LLMClientFactory.create({")
  console.log(`     provider: '${info.recommended}',`)
  console.log("     anthropic: {")
  console.log(`       model: CLAUDE_4_5.SONNET,  // '${CLAUDE_4_5.SONNET}'`)
  console.log("     }")
  console.log("   })")
  console.log("   ```")

  console.log("\n" + "=".repeat(50))
}

main().catch(console.error)
