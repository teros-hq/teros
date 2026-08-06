import type { ModelDefinition } from "../types"

/**
 * openai-codex-oauth model definitions
 */
export const MODELS_OPENAI_CODEX_OAUTH: ModelDefinition[] = [
  // ============================================================================
  // OPENAI CODEX (OAuth — ChatGPT Pro/Plus subscription)
  // Costs are zero — included in ChatGPT subscription
  // Context: 400K input, 128K output
  // ============================================================================
  {
    modelId: "gpt-5-5",
    provider: "openai-codex-oauth",
    name: "GPT-5.5",
    description:
      "Most capable Codex model. Frontier GPT for coding, computer use, research, and knowledge work.",
    modelString: "gpt-5.5",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-4",
    provider: "openai-codex-oauth",
    name: "GPT-5.4",
    description: "Combines coding, reasoning, native computer use, and professional workflows.",
    modelString: "gpt-5.4",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-3-codex",
    provider: "openai-codex-oauth",
    name: "GPT-5.3 Codex",
    description:
      "Industry-leading model for complex software engineering. Most capable agentic coding model with 400K context.",
    modelString: "gpt-5.3-codex",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-3-codex-spark",
    provider: "openai-codex-oauth",
    name: "GPT-5.3 Codex Spark",
    description:
      "Lightweight, low-latency Codex variant for quick iterations and interactive coding.",
    modelString: "gpt-5.3-codex-spark",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 32000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 70000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-2",
    provider: "openai-codex-oauth",
    name: "GPT-5.2",
    description: "GPT-5.2 via ChatGPT Pro/Plus subscription.",
    modelString: "gpt-5.2",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-2-codex",
    provider: "openai-codex-oauth",
    name: "GPT-5.2 Codex",
    description:
      "Intelligent coding model for long-horizon, agentic tasks. Supports text and image input.",
    modelString: "gpt-5.2-codex",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-1-codex-max",
    provider: "openai-codex-oauth",
    name: "GPT-5.1 Codex Max",
    description: "Optimized for long-horizon, agentic coding and enterprise-scale refactoring.",
    modelString: "gpt-5.1-codex-max",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-1-codex",
    provider: "openai-codex-oauth",
    name: "GPT-5.1 Codex",
    description: "Agentic coding version of GPT-5.1 via ChatGPT Pro/Plus subscription.",
    modelString: "gpt-5.1-codex",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-1-codex-mini",
    provider: "openai-codex-oauth",
    name: "GPT-5.1 Codex Mini",
    description: "Cost-effective, lightweight Codex model for general coding tasks.",
    modelString: "gpt-5.1-codex-mini",
    billingType: "subscription",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 20000,
    },
    status: "active",
  },
]
