#!/usr/bin/env bun
/**
 * End-to-end Ollama provider test through the PLATFORM's own stack:
 * ProviderService.discoverOllamaModels (live /api/tags) + LLMClientFactory
 * (the same client the message handler uses) against RAW's local Ollama.
 */
import { MongoClient } from "mongodb"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"
import { ProviderService } from "../services/provider-service"
import { LLMClientFactory } from "@teros/core"

const __dirname_local = dirname(fileURLToPath(import.meta.url))

async function main() {
  const secretsPath = "/opt/teros/.secrets"
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"
  const mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  const db = mongoClient.db(mongoDatabase)

  const svc = new ProviderService(db)

  // 1. Model discovery — same code path as provider.test / provider.add
  console.log("=== 1. discoverOllamaModels (http://localhost:11434) ===")
  const models = await (svc as any).discoverOllamaModels("http://localhost:11434")
  for (const m of models) console.log(`  ${m.modelId}  →  ${m.modelString}`, JSON.stringify(m.capabilities))

  // 2. Real conversation through LLMClientFactory — same client the message handler builds
  console.log("\n=== 2. LLM conversation via platform client (gpt-oss:20b, smaller/faster on CPU) ===")
  const model = models.find((m: any) => m.modelString.includes("gpt-oss")) ?? models[0]
  console.log(`  using: ${model.modelString}`)
  // Same factory + config shape the message handler builds for ollama
  const client = await LLMClientFactory.create({
    provider: "ollama",
    ollama: {
      baseUrl: "http://localhost:11434",
      model: model.modelString,
      maxTokens: 200,
    },
  })

  const t0 = Date.now()
  const sessionId = "test-ollama-e2e"
  let streamed = ""
  const response = await client.streamMessage({
    messages: [
      {
        info: {
          id: "message_test_1",
          sessionID: sessionId,
          role: "user",
          time: { created: Date.now() },
        },
        parts: [
          {
            id: "part_test_1",
            sessionID: sessionId,
            messageID: "message_test_1",
            type: "text",
            text: "Eres un asistente de Teros. Responde en una sola frase corta: ¿qué ventaja tiene ejecutar modelos localmente con Ollama?",
          } as any,
        ],
      },
    ],
    systemPrompt: "You are a helpful assistant.",
    maxTokens: 200,
    callbacks: { onText: (chunk: string) => { streamed += chunk } },
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  ✓ responded in ${elapsed}s`)
  console.log(`  stopReason: ${response.stopReason}`)
  console.log(`  usage: ${JSON.stringify(response.usage ?? null)}`)
  console.log(`  metadata: ${JSON.stringify(response.metadata ?? null)}`)
  console.log(`  streamed content: ${JSON.stringify(streamed).slice(0, 400)}`)

  await mongoClient.close()
  console.log("\nDONE — Ollama provider works end-to-end through the platform stack.")
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1) })
