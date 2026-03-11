/**
 * Model Definitions
 *
 * SINGLE SOURCE OF TRUTH for all LLM model definitions.
 *
 * This file is imported by:
 * - sync-models.ts: To sync models to MongoDB
 * - provider-service.ts: To discover models for user providers
 *
 * When adding a new model, add it here and it will be available everywhere.
 *
 * Providers:
 * - 'anthropic': Uses API key authentication
 * - 'anthropic-oauth': Uses OAuth (Claude Max subscription)
 * - 'openai': OpenAI API
 * - 'openrouter': OpenRouter unified API (400+ models)
 * - 'google': Google AI (Gemini models)
 * - 'groq': Groq API (fast inference)
 * - 'zhipu': Z.ai / ZhipuAI (GLM models)
 * - 'zhipu-coding': Z.ai coding API
 * - 'openai-codex-oauth': Uses OAuth (ChatGPT Pro/Plus subscription via Codex Device Flow)
 */

import type { Model } from '../types/database';

/**
 * Model definition type (without timestamps - those are added by sync)
 */
export type ModelDefinition = Omit<Model, 'createdAt' | 'updatedAt'>;

/**
 * All available LLM models
 */
export const MODEL_DEFINITIONS: ModelDefinition[] = [
  // ============================================================================
  // ANTHROPIC (API Key) - Claude 4.5 models
  // https://docs.anthropic.com/en/docs/about-claude/models
  // ============================================================================
  {
    modelId: 'claude-haiku-4-5',
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Fastest model with near-frontier intelligence. Best for simple tasks.',
    modelString: 'claude-haiku-4-5-20251001',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    description: 'Best balance of intelligence and speed. Excellent for coding and agents.',
    modelString: 'claude-sonnet-4-5-20250929',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-6',
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6',
    description: 'Latest Sonnet with frontier performance in coding, agents, and professional work. 1M context window.',
    modelString: 'claude-sonnet-4-6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 64000,
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
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-5',
    provider: 'anthropic',
    name: 'Claude Opus 4.5',
    description: 'Premium model combining maximum intelligence with practical performance.',
    modelString: 'claude-opus-4-5-20251101',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-6',
    provider: 'anthropic',
    name: 'Claude Opus 4.6',
    description: 'Most capable model with state-of-the-art reasoning, coding, and agentic workflows. 128K output tokens.',
    modelString: 'claude-opus-4-6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },

  // ============================================================================
  // ANTHROPIC OAUTH (Claude Max subscription)
  // Sonnet and Opus only
  // ============================================================================
  {
    modelId: 'claude-sonnet-4-5-oauth',
    provider: 'anthropic-oauth',
    name: 'Claude Sonnet 4.5 (OAuth)',
    description: 'Claude Sonnet via Claude Max subscription.',
    modelString: 'claude-sonnet-4-5-20250929',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-5-oauth',
    provider: 'anthropic-oauth',
    name: 'Claude Opus 4.5 (OAuth)',
    description: 'Claude Opus via Claude Max subscription.',
    modelString: 'claude-opus-4-5-20251101',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-6-oauth',
    provider: 'anthropic-oauth',
    name: 'Claude Sonnet 4.6 (OAuth)',
    description: 'Claude Sonnet 4.6 via Claude Max subscription. Frontier performance with 1M context window.',
    modelString: 'claude-sonnet-4-6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 64000,
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
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-6-oauth',
    provider: 'anthropic-oauth',
    name: 'Claude Opus 4.6 (OAuth)',
    description: 'Claude Opus 4.6 via Claude Max subscription. Most capable model with 128K output tokens.',
    modelString: 'claude-opus-4-6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },

  // ============================================================================
  // OPENAI (2025 Models)
  // https://platform.openai.com/docs/models
  // ============================================================================

  // --- GPT-5 Series (Flagship) ---
  {
    modelId: 'gpt-5.2',
    provider: 'openai',
    name: 'GPT-5.2',
    description:
      "OpenAI's latest flagship model. Best for advanced reasoning, coding, and agentic tasks.",
    modelString: 'gpt-5.2',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 25000,
    },
    status: 'active',
  },
  {
    modelId: 'gpt-5-mini',
    provider: 'openai',
    name: 'GPT-5 Mini',
    description: 'Cost-efficient GPT-5 variant for high-throughput workloads.',
    modelString: 'gpt-5-mini',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },

  // --- O-Series (Reasoning) ---
  {
    modelId: 'o3',
    provider: 'openai',
    name: 'o3',
    description: "OpenAI's advanced reasoning model with strong multimodal capabilities.",
    modelString: 'o3',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 100000,
    },
    defaults: {
      temperature: 1.0, // o-series uses fixed temperature
      maxTokens: 32768,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 32768,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 25000,
    },
    status: 'active',
  },
  {
    modelId: 'o3-pro',
    provider: 'openai',
    name: 'o3 Pro',
    description: 'o3 with extended reasoning time for more reliable outputs on complex tasks.',
    modelString: 'o3-pro',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 100000,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 32768,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 32768,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 25000,
    },
    status: 'disabled', // Enable for premium use cases
  },
  {
    modelId: 'o4-mini',
    provider: 'openai',
    name: 'o4 Mini',
    description: 'High-volume reasoning model. Fast and cost-efficient.',
    modelString: 'o4-mini',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },

  // --- GPT-4.1 Series ---
  {
    modelId: 'gpt-4.1',
    provider: 'openai',
    name: 'GPT-4.1',
    description:
      'Excellent for coding and precise instruction following. Replaces GPT-4.5 preview.',
    modelString: 'gpt-4.1',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },
  {
    modelId: 'gpt-4.1-mini',
    provider: 'openai',
    name: 'GPT-4.1 Mini',
    description: 'Cost-efficient GPT-4.1 variant for high-throughput use cases.',
    modelString: 'gpt-4.1-mini',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 2000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 10000,
    },
    status: 'active',
  },

  // --- Legacy (still available but superseded) ---
  {
    modelId: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o (Legacy)',
    description: 'Multimodal model with image capabilities. Migrating to GPT-4.1/5.x.',
    modelString: 'gpt-4o',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'disabled', // Legacy, use gpt-4.1 or gpt-5.2 instead
  },

  // ============================================================================
  // GOOGLE (Gemini)
  // ============================================================================
  {
    modelId: 'gemini-2.0-flash',
    provider: 'google',
    name: 'Gemini 2.0 Flash',
    description: "Google's fast multimodal model with native tool use.",
    modelString: 'gemini-2.0-flash',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: 'disabled', // Not implemented yet
  },
  {
    modelId: 'gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro',
    description: "Google's most capable model with extended thinking.",
    modelString: 'gemini-2.5-pro-preview-06-05',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: 'disabled', // Not implemented yet
  },

  // ============================================================================
  // ZHIPU (Z.ai / ZhipuAI - GLM models)
  // https://docs.z.ai/
  // ============================================================================
  {
    modelId: 'glm-4.7',
    provider: 'zhipu',
    name: 'GLM 4.7',
    description: "Z.ai's latest flagship model with 200K context. Excellent for coding, reasoning, and agentic workflows.",
    modelString: 'glm-4.7',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 4096,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'glm-4.6',
    provider: 'zhipu',
    name: 'GLM 4.6',
    description: "Z.ai's previous flagship model with excellent reasoning and tool use capabilities.",
    modelString: 'glm-4.6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },
  {
    modelId: 'glm-4.7-coding',
    provider: 'zhipu-coding',
    name: 'GLM 4.7 Coding',
    description: "Z.ai's latest coding-optimized model via the coding API endpoint. 200K context, optimized for real-world development.",
    modelString: 'glm-4.7',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 4096,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'glm-4.6-coding',
    provider: 'zhipu-coding',
    name: 'GLM 4.6 Coding',
    description: "Z.ai's previous coding-optimized model via the coding API endpoint.",
    modelString: 'glm-4.6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },
  {
    modelId: 'glm-4.6v',
    provider: 'zhipu',
    name: 'GLM 4.6V',
    description: "Z.ai's vision-enabled flagship model with multimodal capabilities.",
    modelString: 'glm-4.6v',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'active',
  },
  {
    modelId: 'glm-4',
    provider: 'zhipu',
    name: 'GLM 4',
    description: "Z.ai's previous generation model. Still very capable.",
    modelString: 'glm-4',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'disabled', // Enable if needed
  },

  // ============================================================================
  // GROQ (Fast inference)
  // ============================================================================
  {
    modelId: 'llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B (Groq)',
    description: "Meta's Llama 3.3 70B on Groq. Extremely fast inference.",
    modelString: 'llama-3.3-70b-versatile',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'disabled', // Not implemented yet
  },
  {
    modelId: 'mixtral-8x7b-32768',
    provider: 'groq',
    name: 'Mixtral 8x7B (Groq)',
    description: "Mistral's MoE model on Groq. Fast and capable.",
    modelString: 'mixtral-8x7b-32768',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 2000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 25000,
      targetSize: 20000,
      protectRecent: 5000,
    },
    status: 'disabled', // Not implemented yet
  },

  // ============================================================================
  // OPENROUTER (Unified API for 400+ models)
  // https://openrouter.ai/models
  // ============================================================================
  {
    modelId: 'deepseek-v3',
    provider: 'openrouter',
    name: 'DeepSeek V3',
    description: 'Excellent for coding and reasoning. 90% cheaper than Claude Sonnet.',
    modelString: 'deepseek/deepseek-chat',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 64000,
      maxOutputTokens: 8192,
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
      triggerAt: 50000,
      targetSize: 30000,
      protectRecent: 10000,
    },
    status: 'active',
  },
  {
    modelId: 'llama-3.3-70b',
    provider: 'openrouter',
    name: 'Llama 3.3 70B',
    description: "Meta's Llama 3.3 70B. Free or very economical for simple tasks.",
    modelString: 'meta-llama/llama-3.3-70b-instruct',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 10000,
    },
    status: 'active',
  },
  {
    modelId: 'qwen-2.5-coder-32b',
    provider: 'openrouter',
    name: 'Qwen 2.5 Coder 32B',
    description: 'Specialized coding model from Alibaba. Excellent for code generation.',
    modelString: 'qwen/qwen-2.5-coder-32b-instruct',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 8192,
    },
    compaction: {
      triggerAt: 25000,
      targetSize: 15000,
      protectRecent: 5000,
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-auto-cheapest',
    provider: 'openrouter',
    name: 'OpenRouter Auto (Cheapest)',
    description:
      'Automatic model selection optimized for cost. Routes to the cheapest capable model.',
    modelString: 'openrouter/auto',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
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
      targetSize: 60000,
      protectRecent: 10000,
    },
    providerConfig: {
      routingStrategy: 'cheapest',
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-auto-best',
    provider: 'openrouter',
    name: 'OpenRouter Auto (Best)',
    description:
      'Automatic model selection optimized for quality. Routes to the best model for the task.',
    modelString: 'openrouter/auto',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 16384,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    providerConfig: {
      routingStrategy: 'best',
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-claude-sonnet-4-5',
    provider: 'openrouter',
    name: 'Claude Sonnet 4.5 (OpenRouter)',
    description: 'Anthropic Claude Sonnet 4.5 via OpenRouter. Excellent for coding and agents.',
    modelString: 'anthropic/claude-sonnet-4.5',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-claude-sonnet-4-6',
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6 (OpenRouter)',
    description: 'Latest Sonnet with frontier performance. 1M context window. Same price as 4.5.',
    modelString: 'anthropic/claude-sonnet-4.6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 64000,
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
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-claude-opus-4-5',
    provider: 'openrouter',
    name: 'Claude Opus 4.5 (OpenRouter)',
    description: 'Anthropic Claude Opus 4.5 via OpenRouter. Most capable model for complex tasks.',
    modelString: 'anthropic/claude-opus-4.5',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-claude-opus-4-6',
    provider: 'openrouter',
    name: 'Claude Opus 4.6 (OpenRouter)',
    description: 'Anthropic Claude Opus 4.6 via OpenRouter. State-of-the-art reasoning and coding with 128K output.',
    modelString: 'anthropic/claude-opus-4.6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: 'active',
  },
  {
    modelId: 'gpt-4o-openrouter',
    provider: 'openrouter',
    name: 'GPT-4o (OpenRouter)',
    description: 'OpenAI GPT-4o via OpenRouter. Multimodal with vision capabilities.',
    modelString: 'openai/gpt-4o',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
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
      targetSize: 60000,
      protectRecent: 15000,
    },
    status: 'active',
  },
  {
    modelId: 'kimi-k2.5',
    provider: 'openrouter',
    name: 'Kimi K2.5',
    description:
      "Moonshot AI's flagship multimodal agentic model. 256K context, MoE architecture with thinking mode.",
    modelString: 'moonshotai/kimi-k2.5',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 256000,
      maxOutputTokens: 16384,
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
      triggerAt: 200000,
      targetSize: 150000,
      protectRecent: 25000,
    },
    status: 'active',
  },

  // ============================================================================
  // OLLAMA - Local models
  // Requires Ollama server running (e.g., http://midgar:11434)
  // ============================================================================
  {
    modelId: 'qwen3-coder-30b',
    provider: 'ollama',
    name: 'Qwen3 Coder 30B',
    description: 'Specialized coding model running locally via Ollama. Excellent for development.',
    modelString: 'qwen3-coder:30b',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 8192,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },
  {
    modelId: 'qwen2.5-7b-instruct',
    provider: 'ollama',
    name: 'Qwen 2.5 7B Instruct',
    description: 'Fast and capable general-purpose model. Good balance of speed and quality.',
    modelString: 'qwen2.5:7b-instruct',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },
  {
    modelId: 'deepseek-r1',
    provider: 'ollama',
    name: 'DeepSeek R1',
    description: 'Reasoning-focused model with strong analytical capabilities.',
    modelString: 'deepseek-r1:latest',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 8192,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },

  // ============================================================================
  // OPENAI CODEX (OAuth — ChatGPT Pro/Plus subscription)
  // Costs are zero — included in ChatGPT subscription
  // Context: 400K input, 128K output
  // ============================================================================
  {
    modelId: 'gpt-5-4',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.4',
    description: 'Most capable Codex model. Combines coding, reasoning, native computer use, and professional workflows.',
    modelString: 'gpt-5.4',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-3-codex',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.3 Codex',
    description: 'Industry-leading model for complex software engineering. Most capable agentic coding model with 400K context.',
    modelString: 'gpt-5.3-codex',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-2',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.2',
    description: 'GPT-5.2 via ChatGPT Pro/Plus subscription.',
    modelString: 'gpt-5.2',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-2-codex',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.2 Codex',
    description: 'Intelligent coding model for long-horizon, agentic tasks. Supports text and image input.',
    modelString: 'gpt-5.2-codex',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-1-codex-max',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.1 Codex Max',
    description: 'Optimized for long-horizon, agentic coding and enterprise-scale refactoring.',
    modelString: 'gpt-5.1-codex-max',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-1-codex',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.1 Codex',
    description: 'Agentic coding version of GPT-5.1 via ChatGPT Pro/Plus subscription.',
    modelString: 'gpt-5.1-codex',
    billingType: 'subscription',
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
    status: 'active',
  },
  {
    modelId: 'gpt-5-1-codex-mini',
    provider: 'openai-codex-oauth',
    name: 'GPT-5.1 Codex Mini',
    description: 'Cost-effective, lightweight Codex model for general coding tasks.',
    modelString: 'gpt-5.1-codex-mini',
    billingType: 'subscription',
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
    status: 'active',
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get models filtered by provider type
 */
export function getModelsByProvider(providerType: string): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.provider === providerType);
}

/**
 * Get only active models
 */
export function getActiveModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.status === 'active');
}

/**
 * Get active models for a specific provider
 */
export function getActiveModelsByProvider(providerType: string): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.provider === providerType && m.status === 'active');
}
