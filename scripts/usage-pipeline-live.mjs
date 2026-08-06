#!/usr/bin/env node
/**
 * Pre-merge live smoke of the usage pipeline against a REAL provider (A7.8 / TER-673).
 *
 * The usage-chunk bug reached prod because every unit test mocked the stream; a
 * branch that never ran against a real provider looked green. This 2-stage smoke
 * closes that gap cheaply (~$0.001/run):
 *
 *   Stage A — real OpenAICompatibleLLMAdapter + FIREWORKS_API_KEY, a ~16-token
 *             turn, asserting the streamed usage is non-zero and coherent
 *             (the "subset canary": cacheRead ≤ input).
 *   Stage B — feed that real usage through the cost estimator and assert the
 *             persisted delta would carry non-zero tokens + cost (the write path).
 *
 * Wire in CI as `if: github.event_name == 'push'` with FIREWORKS_API_KEY in the
 * secrets. Skips (exit 0) with a clear message when the key is absent, so local
 * runs and forks are not blocked.
 *
 * Usage: FIREWORKS_API_KEY=... bun scripts/usage-pipeline-live.mjs
 * (bun/tsx — resolves @teros/core's dist directory imports; plain node does not).
 */

import { estimateCostUsd, OpenAICompatibleLLMAdapter } from "@teros/core"

const KEY = process.env.FIREWORKS_API_KEY
if (!KEY) {
  console.log("⏭  FIREWORKS_API_KEY not set — skipping live usage smoke (exit 0).")
  process.exit(0)
}

const BASE_URL = process.env.FIREWORKS_BASE_URL ?? "https://api.fireworks.ai/inference/v1"
const MODEL = process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/kimi-k2-instruct"

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

async function stageA() {
  console.log(`▶ Stage A — real turn against ${MODEL}`)
  const adapter = new OpenAICompatibleLLMAdapter({
    baseUrl: BASE_URL,
    model: MODEL,
    apiKey: KEY,
    defaultMaxTokens: 16,
  })

  const res = await adapter.streamMessage({
    messages: [{ role: "user", parts: [{ type: "text", text: "Reply with exactly: ok" }] }],
    maxTokens: 16,
  })

  const usage = res.usage
  if (!usage) fail("Stage A: no usage returned (the usage chunk was dropped — the exact prod bug).")
  const cached = usage.cacheReadInputTokens ?? 0
  console.log(`  usage: in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${cached}`)

  if (!(usage.inputTokens > 0)) fail("Stage A: inputTokens must be > 0.")
  if (!(usage.outputTokens > 0)) fail("Stage A: outputTokens must be > 0.")
  // The subset canary: cached read tokens are a subset of the prompt tokens.
  if (cached > usage.inputTokens)
    fail(`Stage A: cacheRead (${cached}) > input (${usage.inputTokens}).`)

  console.log("  ✓ Stage A: streamed usage is non-zero and coherent.")
  return usage
}

async function stageB(usage) {
  console.log("▶ Stage B — cost/delta write path")
  const cost = estimateCostUsd({
    provider: "teros",
    modelId: MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cacheReadInputTokens ?? 0,
  })
  console.log(`  cost=$${cost ?? "—"}`)

  const totalTokens = usage.inputTokens + usage.outputTokens
  if (!(totalTokens > 0)) fail("Stage B: the delta would persist zero tokens.")
  // Kimi on Fireworks has a real price → cost must be a positive number.
  if (cost == null || !(cost > 0)) fail(`Stage B: expected a positive cost, got ${cost}.`)

  console.log("  ✓ Stage B: the delta would persist non-zero tokens + cost.")
}

const usage = await stageA()
await stageB(usage)
console.log("✅ Live usage smoke passed.")
