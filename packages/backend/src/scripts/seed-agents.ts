/**
 * Seed Agents Script
 * Populates catalog/reference collections with initial data
 *
 * Usage:
 *   bun run seed-agents           # Upsert mode (safe, non-destructive)
 *   bun run seed-agents --force   # Force mode (deletes and recreates all data)
 *
 * Collections managed:
 *   - models: Available LLM models catalog
 *   - agent_cores: Base personality engines (Alice, Iria)
 *   - agents: User-facing agent instances (Alice)
 *
 * Collections NOT managed (handled elsewhere):
 *   - mca_catalog: Use `bun run sync-mcas` to sync from manifest.json files
 *   - apps: Runtime data - user/system installed MCP instances
 *   - agent_app_access: Runtime data - agent permissions to apps
 */

import { readFileSync } from "fs"
import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"
import type { AgentCore, AgentInstance, Model } from "../types/database"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Parse arguments
const args = process.argv.slice(2)
const forceMode = args.includes("--force")

// Load base agent core prompt from file
const BASE_AGENT_CORE_PROMPT = readFileSync(
  join(__dirname, "../prompts/base-agent-core.md"),
  "utf-8",
)

// ============================================================================
// MODELS (LLM Catalog)
// ============================================================================

const models: Model[] = [
  // ============================================================================
  // Anthropic API Models (pay-per-use)
  // Pricing verified: https://claude.com/pricing#api (January 2025)
  // ============================================================================
  {
    modelId: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Optimal balance of intelligence, cost, and speed.",
    modelString: "claude-sonnet-4-5-20250929",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    // Pricing per million tokens (USD) - for prompts ≤200K tokens
    cost: {
      input: 3, // $3 / MTok
      output: 15, // $15 / MTok
      cacheRead: 0.3, // $0.30 / MTok
      cacheWrite: 3.75, // $3.75 / MTok
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8_192,
    },
    reservations: {
      systemPrompt: 20_000,
      memory: 10_000,
      output: 8_000,
    },
    compaction: {
      triggerAt: 180_000,
      targetSize: 120_000,
      protectRecent: 40_000,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    modelId: "claude-haiku-4-5",
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    description: "Fastest, most cost-efficient model.",
    modelString: "claude-haiku-4-5-20251001",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    // Pricing per million tokens (USD)
    cost: {
      input: 1, // $1 / MTok
      output: 5, // $5 / MTok
      cacheRead: 0.1, // $0.10 / MTok
      cacheWrite: 1.25, // $1.25 / MTok
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4_096,
    },
    reservations: {
      systemPrompt: 15_000,
      memory: 8_000,
      output: 4_000,
    },
    compaction: {
      triggerAt: 180_000,
      targetSize: 120_000,
      protectRecent: 40_000,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    modelId: "claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Most intelligent model for building agents and coding.",
    modelString: "claude-opus-4-5-20251101",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    // Pricing per million tokens (USD)
    cost: {
      input: 5, // $5 / MTok
      output: 25, // $25 / MTok
      cacheRead: 0.5, // $0.50 / MTok
      cacheWrite: 6.25, // $6.25 / MTok
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8_192,
    },
    reservations: {
      systemPrompt: 20_000,
      memory: 15_000,
      output: 8_000,
    },
    compaction: {
      triggerAt: 180_000,
      targetSize: 120_000,
      protectRecent: 40_000,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },

  // ============================================================================
  // Anthropic OAuth Models (Claude Max subscription - $0 cost)
  // These use OAuth authentication and are included in the subscription
  // ============================================================================
  {
    modelId: "claude-sonnet-4-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Sonnet 4.5 (Max)",
    description: "Claude Sonnet via Claude Max subscription. No per-token cost.",
    modelString: "claude-sonnet-4-5-20250929",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    // No cost - included in Claude Max subscription
    cost: {
      input: 0,
      output: 0,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8_192,
    },
    reservations: {
      systemPrompt: 20_000,
      memory: 10_000,
      output: 8_000,
    },
    compaction: {
      triggerAt: 180_000,
      targetSize: 120_000,
      protectRecent: 40_000,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    modelId: "claude-opus-4-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Opus 4.5 (Max)",
    description: "Claude Opus via Claude Max subscription. No per-token cost.",
    modelString: "claude-opus-4-5-20251101",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    // No cost - included in Claude Max subscription
    cost: {
      input: 0,
      output: 0,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8_192,
    },
    reservations: {
      systemPrompt: 20_000,
      memory: 15_000,
      output: 8_000,
    },
    compaction: {
      triggerAt: 180_000,
      targetSize: 120_000,
      protectRecent: 40_000,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// ============================================================================
// AGENT CORES (Engines/Personalities)
// ============================================================================

const agentCores: AgentCore[] = [
  {
    coreId: "alice",
    name: "Alice",
    fullName: "Alice Evergreen",
    version: "v1.0",
    systemPrompt: BASE_AGENT_CORE_PROMPT,
    personality: ["Empathetic", "Creative", "Supportive", "Detail-oriented", "Patient"],
    capabilities: [
      "Software Development",
      "Project Management",
      "Code Review",
      "Documentation",
      "Technical Research",
      "Creative Problem Solving",
    ],
    avatarUrl: "alice-avatar.jpg",
    // LLM Configuration - Alice uses Opus 4.5 (most capable)
    modelId: "claude-opus-4-5",
    modelOverrides: {
      temperature: 0.7,
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    coreId: "iria",
    name: "Iria",
    fullName: "Iria Devon",
    version: "v1.0",
    systemPrompt: BASE_AGENT_CORE_PROMPT,
    personality: ["Direct", "Efficient", "Technical", "Professional", "Action-oriented"],
    capabilities: [
      "Teros Development",
      "Software Engineering",
      "System Architecture",
      "Code Quality",
      "DevOps",
      "Rapid Execution",
    ],
    avatarUrl: "iria-avatar.jpg",
    // LLM Configuration - Iria uses Sonnet 4.5 (balanced)
    modelId: "claude-sonnet-4-5",
    modelOverrides: {
      temperature: 0.5, // More deterministic for technical tasks
    },
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// ============================================================================
// AGENT INSTANCES (User-facing agents)
// ============================================================================

const agentInstances: AgentInstance[] = [
  {
    agentId: "agent:alice",
    coreId: "alice", // Uses Alice's engine/personality
    name: "Alice",
    fullName: "Alice Evergreen",
    role: "Personal Assistant",
    intro: "I help with software engineering tasks, project management, and technical workflows.",
    // No avatarUrl - will fall back to alice core's avatar
    status: "active",
    maxSteps: 80,
    context: `User-focused and collaborative approach. Specializes in Personal Workflow Optimization, Technical Mentoring, and Creative Brainstorming. Friendly response style.`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// ============================================================================
// SEED FUNCTIONS
// ============================================================================

async function seedAgents() {
  console.log("Seeding agent system...\n")
  console.log(`Mode: ${forceMode ? "🔴 FORCE (delete + insert)" : "🟢 UPSERT (safe)"}\n`)

  // Load secrets for DB credentials
  const secretsPath = join(__dirname, "../../../../.secrets")
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"

  const mongoClient = new MongoClient(mongoUri)

  try {
    await mongoClient.connect()
    const db = mongoClient.db(mongoDatabase)

    // ========================================================================
    // 1. SEED MODELS
    // ========================================================================

    console.log("Seeding Models (LLM Catalog)...")
    const modelsCollection = db.collection<Model>("models")

    let modelsInserted = 0
    let modelsUpdated = 0

    if (forceMode) {
      await modelsCollection.deleteMany({})
      const result = await modelsCollection.insertMany(models)
      modelsInserted = result.insertedCount
    } else {
      for (const model of models) {
        // Separate createdAt from the rest to avoid conflict
        const { createdAt, ...modelWithoutCreatedAt } = model
        const result = await modelsCollection.updateOne(
          { modelId: model.modelId },
          {
            $set: { ...modelWithoutCreatedAt, updatedAt: new Date().toISOString() },
            $setOnInsert: { createdAt: new Date().toISOString() },
          },
          { upsert: true },
        )
        if (result.upsertedCount > 0) modelsInserted++
        else if (result.modifiedCount > 0) modelsUpdated++
      }
    }

    console.log(`  Inserted: ${modelsInserted}, Updated: ${modelsUpdated}\n`)

    // List models
    console.log("Models:")
    const insertedModels = await modelsCollection.find({}).toArray()
    insertedModels.forEach((model) => {
      console.log(`   - ${model.name} (${model.modelId}) [${model.provider}]`)
    })

    // ========================================================================
    // 2. SEED AGENT CORES
    // ========================================================================

    console.log("\nSeeding Agent Cores (Engines/Personalities)...")
    const coresCollection = db.collection<AgentCore>("agent_cores")

    let coresInserted = 0
    let coresUpdated = 0

    if (forceMode) {
      await coresCollection.deleteMany({})
      const result = await coresCollection.insertMany(agentCores)
      coresInserted = result.insertedCount
    } else {
      for (const core of agentCores) {
        const { createdAt, ...coreWithoutCreatedAt } = core
        const result = await coresCollection.updateOne(
          { coreId: core.coreId },
          {
            $set: { ...coreWithoutCreatedAt, updatedAt: new Date().toISOString() },
            $setOnInsert: { createdAt: new Date().toISOString() },
          },
          { upsert: true },
        )
        if (result.upsertedCount > 0) coresInserted++
        else if (result.modifiedCount > 0) coresUpdated++
      }
    }

    console.log(`  Inserted: ${coresInserted}, Updated: ${coresUpdated}\n`)

    // List cores
    console.log("Agent Cores:")
    const insertedCores = await coresCollection.find({}).toArray()
    for (const core of insertedCores) {
      const model = await modelsCollection.findOne({ modelId: core.modelId })
      console.log(`   - ${core.fullName} (${core.coreId}) -> ${model?.name || "UNKNOWN"}`)
    }

    // ========================================================================
    // 3. SEED AGENT INSTANCES
    // ========================================================================

    console.log("\nSeeding Agent Instances (User-facing agents)...")
    const instancesCollection = db.collection<AgentInstance>("agents")

    let instancesInserted = 0
    let instancesUpdated = 0

    if (forceMode) {
      await instancesCollection.deleteMany({})
      const result = await instancesCollection.insertMany(agentInstances)
      instancesInserted = result.insertedCount
    } else {
      for (const instance of agentInstances) {
        const { createdAt, ...instanceWithoutCreatedAt } = instance
        const result = await instancesCollection.updateOne(
          { agentId: instance.agentId },
          {
            $set: { ...instanceWithoutCreatedAt, updatedAt: new Date().toISOString() },
            $setOnInsert: { createdAt: new Date().toISOString() },
          },
          { upsert: true },
        )
        if (result.upsertedCount > 0) instancesInserted++
        else if (result.modifiedCount > 0) instancesUpdated++
      }
    }

    console.log(`  Inserted: ${instancesInserted}, Updated: ${instancesUpdated}\n`)

    // List instances
    console.log("Agent Instances:")
    const insertedInstances = await instancesCollection.find({}).toArray()
    for (const instance of insertedInstances) {
      const core = await coresCollection.findOne({ coreId: instance.coreId })
      console.log(
        `   - ${instance.fullName} (${instance.agentId}) -> ${core?.name || "UNKNOWN"} core`,
      )
    }

    console.log("\n✅ Agent system seeded successfully!")
    console.log("\nSummary:")
    console.log(`   - Models: ${modelsInserted} inserted, ${modelsUpdated} updated`)
    console.log(`   - Agent Cores: ${coresInserted} inserted, ${coresUpdated} updated`)
    console.log(`   - Agent Instances: ${instancesInserted} inserted, ${instancesUpdated} updated`)

    console.log("\n💡 Note: MCP catalog is managed by `bun run sync-mcas`")
    console.log("   Apps and agent_app_access are runtime data, not seeded.")
  } catch (error) {
    console.error("Error seeding agents:", error)
    throw error
  } finally {
    await mongoClient.close()
    console.log("\nDone!")
  }
}

// Run if called directly
if (import.meta.main) {
  seedAgents()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

export { seedAgents }
