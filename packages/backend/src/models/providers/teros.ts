import type { ModelDefinition } from '../types';

/**
 * Teros model definitions
 *
 * TerosProvider — Official Teros platform provider.
 * Served via Fireworks AI (OpenAI-compatible API) with Zero Data Retention.
 * Base URL: https://api.fireworks.ai/inference/v1
 * https://docs.fireworks.ai/
 */
export const MODELS_TEROS: ModelDefinition[] = [
  // ============================================================================
  // TEROS (Fireworks AI — Zero Data Retention, OpenAI-compatible API)
  // ============================================================================
  {
    modelId: 'teros-kimi-k2.6',
    provider: 'teros',
    name: 'Kimi K2.6',
    description:
      'Moonshot AI Kimi K2.6 via Fireworks AI. 262K context, function calling, reasoning, and vision. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/kimi-k2p6',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
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
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.95,
      output: 4.00,
      cacheRead: 0.16,
    },
    status: 'active',
  },
  {
    modelId: 'teros-glm-5p2',
    provider: 'teros',
    name: 'GLM-5.2',
    description:
      'Zhipu AI GLM-5.2 via Fireworks AI. 1M context, function calling, reasoning, and agentic workflows. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/glm-5p2',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 131072,
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
      protectRecent: 20000,
    },
    cost: {
      input: 1.40,
      output: 4.40,
      cacheRead: 0.14,
    },
    status: 'active',
  },
  {
    modelId: 'teros-glm-5p2-fast',
    provider: 'teros',
    name: 'GLM-5.2 Fast',
    description:
      'Zhipu AI GLM-5.2 Fast via Fireworks AI. 1M context, fast router for interactive applications, function calling, reasoning, and agentic workflows. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/routers/glm-5p2-fast',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 131072,
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
      protectRecent: 20000,
    },
    cost: {
      input: 2.10,
      output: 6.60,
      cacheRead: 0.21,
    },
    status: 'active',
  },
  {
    modelId: 'teros-kimi-k2p7-code',
    provider: 'teros',
    name: 'Kimi K2.7 Code',
    description:
      'Moonshot AI Kimi K2.7 Code via Fireworks AI. 262K context, coding-specialized, agentic reasoning, and vision. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/kimi-k2p7-code',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
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
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.95,
      output: 4.00,
      cacheRead: 0.19,
    },
    status: 'active',
  },
  {
    modelId: 'teros-kimi-k2p7-code-fast',
    provider: 'teros',
    name: 'Kimi K2.7 Code Fast',
    description:
      'Moonshot AI Kimi K2.7 Code Fast via Fireworks AI. 262K context, fast router for interactive coding, agentic reasoning, and vision. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/routers/kimi-k2p7-code-fast',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
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
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    cost: {
      input: 1.90,
      output: 8.00,
      cacheRead: 0.38,
    },
    status: 'active',
  },
];

/** Real upstream that serves the `teros` provider (TER-617/F3). */
export type TerosUpstream = 'fireworks' | 'together';

/**
 * Per-model upstream `modelString` map for the `teros` failover (TER-617/F3).
 * The SAME logical model has a DIFFERENT provider model string per upstream, so
 * a fallback must swap `baseUrl` + `apiKey` + `modelString` together — not just
 * the key. `together: null` means the model has no Together equivalent (Kimi
 * K2.7 Code is Fireworks-only) → it can never fail over; the wrapper stays
 * Fireworks-only for it.
 *
 * Keyed by `modelId` (e.g. `teros-kimi-k2.6`), resolved by `resolveTerosUpstream`.
 */
export const TEROS_UPSTREAM_MODELS: Record<
  string,
  { fireworks: string; together: string | null }
> = {
  'teros-kimi-k2.6': {
    fireworks: 'accounts/fireworks/models/kimi-k2p6',
    together: 'moonshotai/kimi-k2.6',
  },
  'teros-glm-5p2': {
    fireworks: 'accounts/fireworks/models/glm-5p2',
    together: null,
  },
  'teros-glm-5p2-fast': {
    fireworks: 'accounts/fireworks/routers/glm-5p2-fast',
    together: null,
  },
  'teros-kimi-k2p7-code': {
    fireworks: 'accounts/fireworks/models/kimi-k2p7-code',
    together: null,
  },
  'teros-kimi-k2p7-code-fast': {
    fireworks: 'accounts/fireworks/routers/kimi-k2p7-code-fast',
    together: null,
  },
};
