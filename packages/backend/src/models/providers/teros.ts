import type { ModelDefinition } from '../types';

/**
 * Teros model definitions (TPROV).
 *
 * TerosProvider — Official Teros platform provider. The user picks a SIZE
 * (Model L / M / S); the admin decides, per Teros provider config, which
 * upstream (Helmcode / Fireworks / Together) and which upstream model serves
 * each size (TPROV-REQ-2, TPROV-REQ-4). The legacy per-model entries below are
 * kept `deprecated` so old pins still resolve until the migration remaps them.
 *
 * @spec TPROV-REQ-1
 */
export const MODELS_TEROS: ModelDefinition[] = [
  // ============================================================================
  // SIZES (TPROV-REQ-1) — the only active teros models. `modelString` is the
  // size id: the upstream model comes from the config at request time.
  // ============================================================================
  ...(['l', 'm', 's'] as const).map((size): ModelDefinition => ({
    modelId: `teros-${size}`,
    provider: 'teros',
    name: `Model ${size.toUpperCase()}`,
    description:
      size === 'l'
        ? 'The Teros working model: the strongest open model on the configured upstream, full reasoning, 1M context, vision.'
        : size === 'm'
          ? 'Fast with reasoning: the light model of the same family, 1M context, vision.'
          : 'Short tasks, summaries and voice: the fastest model on the configured upstream, 1M context.',
    modelString: `teros-${size}`,
    capabilities: { streaming: true, tools: true, vision: true, thinking: true },
    context: { maxTokens: 1048576, maxOutputTokens: 32768 },
    defaults: { temperature: 0.7, maxTokens: 8192 },
    reservations: { systemPrompt: 6000, memory: 12000, output: 8192 },
    compaction: { triggerAt: 800000, targetSize: 500000, protectRecent: 20000 },
    billingType: 'subscription',
    status: 'active',
  })),
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
    status: 'deprecated',
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
    status: 'deprecated',
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
    status: 'deprecated',
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
    status: 'deprecated',
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
    status: 'deprecated',
  },
  {
    modelId: 'teros-kimi-k3',
    provider: 'teros',
    name: 'Kimi K3',
    description:
      'Moonshot AI Kimi K3 via Fireworks AI. 1M context, function calling, reasoning, and vision. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/kimi-k3',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-kimi-k3-fast',
    provider: 'teros',
    name: 'Kimi K3 Fast',
    description:
      'Moonshot AI Kimi K3 Fast via Fireworks AI. 1M context, fast router for interactive long-horizon agent work, function calling, reasoning, and vision. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/routers/kimi-k3-fast',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 4.5,
      output: 22.5,
      cacheRead: 0.45,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-glm-5p3',
    provider: 'teros',
    name: 'GLM-5.3',
    description:
      'Zhipu AI GLM-5.3 via Fireworks AI. 1M context, flagship GLM model for long-horizon coding, agents, and complex project delivery. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/glm-5p3',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 262144,
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
      cacheRead: 0.26,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-glm-5p3-flash',
    provider: 'teros',
    name: 'GLM-5.3 Flash',
    description:
      'Zhipu AI GLM-5.3 Flash via Fireworks AI. 1M context, native multimodal (vision), efficient coding and long-horizon agent tasks at very low cost. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/glm-5p3-flash',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      input: 0.15,
      output: 0.50,
      cacheRead: 0.03,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-glm-5p3-fast',
    provider: 'teros',
    name: 'GLM-5.3 Fast',
    description:
      'Zhipu AI GLM-5.3 Fast via Fireworks AI. 1M context, fast router for interactive applications, flagship GLM for long-horizon coding and agents. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/routers/glm-5p3-fast',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 262144,
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
      input: 2.1,
      output: 6.6,
      cacheRead: 0.39,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-deepseek-v4-pro-0813',
    provider: 'teros',
    name: 'DeepSeek V4 Pro 0813',
    description:
      'DeepSeek V4 Pro snapshot 0813 via Fireworks AI. 1M context, open-weights frontier model for coding and reasoning. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/deepseek-v4-pro-0813',
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
    },
    status: 'deprecated',
  },
  {
    modelId: 'teros-deepseek-v4p1-flash',
    provider: 'teros',
    name: 'DeepSeek V4.1 Flash',
    description:
      'DeepSeek V4.1 Flash via Fireworks AI. 1M context, native multimodal (vision), efficient coding and agentic work at very low cost. Zero Data Retention by default.',
    modelString: 'accounts/fireworks/models/deepseek-v4p1-flash',
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 384000,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.22,
      output: 0.66,
      cacheRead: 0.007,
    },
    status: 'deprecated',
  },
];

/** Real upstream that serves the `teros` provider (TER-617/F3, TPROV-REQ-3). */
export type TerosUpstream = 'fireworks' | 'together' | 'helmcode';
export const TEROS_UPSTREAMS: TerosUpstream[] = ['helmcode', 'fireworks', 'together'];

/** @spec TPROV-REQ-1 */
export type TerosSize = 'l' | 'm' | 's';
export const TEROS_SIZES: TerosSize[] = ['l', 'm', 's'];
export const TEROS_SIZE_MODEL_ID: Record<TerosSize, string> = { l: 'teros-l', m: 'teros-m', s: 'teros-s' };
export const DEFAULT_TEROS_SIZE: TerosSize = 'l';

/** The size behind a teros modelId, or null for anything else (legacy ids included). */
export function sizeOfModelId(modelId: string | undefined | null): TerosSize | null {
  if (modelId === 'teros-l') return 'l';
  if (modelId === 'teros-m') return 'm';
  if (modelId === 'teros-s') return 's';
  return null;
}

export type TerosReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export const TEROS_EFFORTS: TerosReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/**
 * Model families: the same model offered by several upstreams under different
 * strings. Failover (TPROV-REQ-6) and vision routing (TPROV-REQ-7) move within
 * a family, never across.
 */
export type TerosModelFamily =
  | 'glm-5.3'
  | 'glm-5.3-flash'
  | 'glm-5.3-fast'
  | 'deepseek-v4-flash'
  | 'kimi-k3'
  | 'kimi-k3-fast'
  | 'qwen3.6'
  | 'gemma4';

/** The family a request with images is rerouted to when the size's model cannot see (TPROV-REQ-7). */
export const TEROS_VISION_FAMILY: TerosModelFamily = 'glm-5.3-flash';

/** @spec TPROV-REQ-3 */
export interface TerosUpstreamModel {
  modelString: string;
  name: string;
  family: TerosModelFamily;
  vision: boolean;
  /** `reasoning_effort` values the model accepts. */
  efforts: TerosReasoningEffort[];
}

const THINKING: TerosReasoningEffort[] = ['low', 'medium', 'high'];
const ANY: TerosReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/**
 * Upstream catalogue (TPROV-REQ-3). Helmcode vision verified against the live
 * API on 2026-11-03 (glm5.3, glm5.3-flash and deepseek-v4-flash all described a
 * test image); Fireworks/Together flags follow the retired per-model catalogue.
 * @spec TPROV-REQ-3
 */
export const TEROS_UPSTREAM_CATALOG: Record<TerosUpstream, TerosUpstreamModel[]> = {
  helmcode: [
    { modelString: 'glm5.3', name: 'GLM 5.3', family: 'glm-5.3', vision: true, efforts: THINKING },
    { modelString: 'glm5.3-flash', name: 'GLM 5.3 Flash', family: 'glm-5.3-flash', vision: true, efforts: THINKING },
    { modelString: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', family: 'deepseek-v4-flash', vision: true, efforts: ANY },
    { modelString: 'qwen3.6', name: 'Qwen 3.6 35B', family: 'qwen3.6', vision: true, efforts: ANY },
    { modelString: 'gemma4', name: 'Gemma 4 26B', family: 'gemma4', vision: true, efforts: ANY },
  ],
  fireworks: [
    { modelString: 'accounts/fireworks/models/glm-5p3', name: 'GLM-5.3', family: 'glm-5.3', vision: false, efforts: THINKING },
    { modelString: 'accounts/fireworks/models/glm-5p3-flash', name: 'GLM-5.3 Flash', family: 'glm-5.3-flash', vision: true, efforts: THINKING },
    { modelString: 'accounts/fireworks/routers/glm-5p3-fast', name: 'GLM-5.3 Fast', family: 'glm-5.3-fast', vision: false, efforts: THINKING },
    { modelString: 'accounts/fireworks/models/deepseek-v4p1-flash', name: 'DeepSeek V4.1 Flash', family: 'deepseek-v4-flash', vision: true, efforts: ANY },
    { modelString: 'accounts/fireworks/models/kimi-k3', name: 'Kimi K3', family: 'kimi-k3', vision: true, efforts: ANY },
    { modelString: 'accounts/fireworks/routers/kimi-k3-fast', name: 'Kimi K3 Fast', family: 'kimi-k3-fast', vision: true, efforts: ANY },
  ],
  together: [
    { modelString: 'zai-org/GLM-5.3', name: 'GLM-5.3', family: 'glm-5.3', vision: false, efforts: THINKING },
    { modelString: 'zai-org/GLM-5.3-Flash', name: 'GLM-5.3 Flash', family: 'glm-5.3-flash', vision: true, efforts: THINKING },
    { modelString: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', family: 'deepseek-v4-flash', vision: true, efforts: ANY },
    { modelString: 'moonshotai/Kimi-K3', name: 'Kimi K3', family: 'kimi-k3', vision: true, efforts: ANY },
  ],
};

export function findTerosUpstreamModel(upstream: TerosUpstream, modelString: string): TerosUpstreamModel | undefined {
  return TEROS_UPSTREAM_CATALOG[upstream]?.find((m) => m.modelString === modelString);
}

/** The model of `family` on `upstream`, if it offers one. */
export function terosUpstreamModelOfFamily(upstream: TerosUpstream, family: TerosModelFamily): TerosUpstreamModel | undefined {
  return TEROS_UPSTREAM_CATALOG[upstream]?.find((m) => m.family === family);
}

/** @spec TPROV-REQ-4 */
export interface TerosSizeRoute {
  upstream: TerosUpstream;
  modelString: string;
  reasoningEffort: TerosReasoningEffort;
}

export type TerosFailoverMode = 'off' | 'on-error' | 'cutover';

/** @spec TPROV-REQ-4 */
export interface TerosFailoverSetting {
  mode: TerosFailoverMode;
  upstream: TerosUpstream;
}

/**
 * Latency lane of a request (TLANE-REQ-1): `interactive` when a person is
 * waiting, `background` when nobody is watching.
 * @spec TLANE-REQ-1
 */
export type TerosLane = 'interactive' | 'background';
export const TEROS_LANES: TerosLane[] = ['interactive', 'background'];

/** The two routes of a size, one per lane (TLANE-REQ-5). @spec TLANE-REQ-5 */
export interface TerosSizeRoutes {
  interactive: TerosSizeRoute;
  background: TerosSizeRoute;
}

/** The routing part of a Teros provider config (TPROV-REQ-4, TLANE-REQ-5). */
export interface TerosSizesConfig {
  sizes: Record<TerosSize, TerosSizeRoutes>;
  failover: TerosFailoverSetting;
}

/** The same route on both lanes — what migration 20261109_001 writes (TLANE-REQ-6). */
export function sameRouteOnBothLanes(route: TerosSizeRoute): TerosSizeRoutes {
  return { interactive: { ...route }, background: { ...route } };
}

/**
 * TPROV-REQ-4's single route per size: what migration 20261103_001 wrote and
 * what migration 20261109_001 copies onto both lanes.
 * @spec TPROV-REQ-4
 */
export const DEFAULT_TEROS_SIZE_ROUTES: Record<TerosSize, TerosSizeRoute> = {
  l: { upstream: 'fireworks', modelString: 'accounts/fireworks/models/glm-5p3', reasoningEffort: 'high' },
  m: { upstream: 'fireworks', modelString: 'accounts/fireworks/models/glm-5p3-flash', reasoningEffort: 'medium' },
  s: { upstream: 'fireworks', modelString: 'accounts/fireworks/models/deepseek-v4p1-flash', reasoningEffort: 'none' },
};

/**
 * The seeded default (TLANE-REQ-6): TPROV-REQ-4's routes on both lanes, so
 * nothing changes until an admin edits the config.
 * @spec TPROV-REQ-4, TLANE-REQ-6
 */
export const DEFAULT_TEROS_SIZES: TerosSizesConfig = {
  sizes: {
    l: sameRouteOnBothLanes(DEFAULT_TEROS_SIZE_ROUTES.l),
    m: sameRouteOnBothLanes(DEFAULT_TEROS_SIZE_ROUTES.m),
    s: sameRouteOnBothLanes(DEFAULT_TEROS_SIZE_ROUTES.s),
  },
  failover: { mode: 'off', upstream: 'together' },
};

/** Legacy teros ids → size (TPROV-REQ-12). Anything not listed maps to L. */
export const TEROS_LEGACY_SIZE: Record<string, TerosSize> = {
  'teros-glm-5p3-flash': 'm',
  'teros-deepseek-v4p1-flash': 's',
};

export function sizeForLegacyModelId(modelId: string): TerosSize {
  return sizeOfModelId(modelId) ?? TEROS_LEGACY_SIZE[modelId] ?? 'l';
}

function isUpstream(x: unknown): x is TerosUpstream {
  return x === 'fireworks' || x === 'together' || x === 'helmcode';
}

/**
 * Validate one route against the catalogue; `field` prefixes the offending
 * field in the error (e.g. `sizes.l.background`).
 */
export function validateTerosSizeRoute(
  input: unknown,
  field: string,
): { ok: true; value: TerosSizeRoute } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: field };
  const r = input as Record<string, unknown>;
  if (!isUpstream(r.upstream)) return { ok: false, error: `${field}.upstream` };
  const model = typeof r.modelString === 'string' ? findTerosUpstreamModel(r.upstream, r.modelString) : undefined;
  if (!model) return { ok: false, error: `${field}.modelString` };
  const effort = r.reasoningEffort as TerosReasoningEffort;
  if (!model.efforts.includes(effort)) return { ok: false, error: `${field}.reasoningEffort` };
  return { ok: true, value: { upstream: r.upstream, modelString: model.modelString, reasoningEffort: effort } };
}

/**
 * Validate a sizes/failover payload against the catalogue (TPROV-REQ-11).
 * Both lanes of every size are required (TLANE-REQ-11). Returns the
 * normalised value or the offending field.
 * @spec TLANE-REQ-11
 */
export function validateTerosSizesConfig(
  input: unknown,
): { ok: true; value: TerosSizesConfig } | { ok: false; error: string } {
  const raw = (input ?? {}) as { sizes?: Record<string, unknown>; failover?: Record<string, unknown> };
  const sizes = {} as Record<TerosSize, TerosSizeRoutes>;
  for (const size of TEROS_SIZES) {
    const routes = (raw.sizes?.[size] ?? {}) as Record<string, unknown>;
    const out = {} as TerosSizeRoutes;
    for (const lane of TEROS_LANES) {
      const v = validateTerosSizeRoute(routes[lane], `sizes.${size}.${lane}`);
      if (!v.ok) return v;
      out[lane] = v.value;
    }
    sizes[size] = out;
  }
  const f = (raw.failover ?? {}) as Record<string, unknown>;
  const mode = f.mode;
  if (mode !== 'off' && mode !== 'on-error' && mode !== 'cutover') return { ok: false, error: 'failover.mode' };
  if (!isUpstream(f.upstream)) return { ok: false, error: 'failover.upstream' };
  return { ok: true, value: { sizes, failover: { mode, upstream: f.upstream } } };
}
