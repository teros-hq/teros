/**
 * Canonical LLM provider registry (TER — monitoring dashboard).
 *
 * Single source of truth for provider id → { label, color, cache support } so the
 * frontend stops carrying three hardcoded, drifting provider lists (the old
 * `PROVIDER_CACHE_STATUS` / `PROVIDER_OPTIONS` / chart palette in AgentUsageWindow)
 * and a brand-new provider becomes a non-event: unknown ids resolve to a stable,
 * hashed color and their raw id as label instead of being dropped from filters.
 *
 * Colors deliberately AVOID indigo (`#5E6AD2`) — that is the action/active/focus
 * accent in the Teros design system, never a data-series color.
 */

export type CacheSupport = 'active' | 'auto' | 'off';

/**
 * How Teros pays the upstream for this provider:
 *   - `usage`        → metered per-token; a per-token cost is meaningful.
 *   - `subscription` → a flat plan (GLM Coding Plan, Claude Max / ChatGPT via
 *                      OAuth). There is NO per-token cost; estimating one is a
 *                      phantom figure, so `estimateCostUsd` returns null and the
 *                      UI shows "Subscription" instead of a fabricated dollar
 *                      amount. Single source of truth for both core (cost gate)
 *                      and the dashboard (label). TER-666 / A2.4.
 */
export type BillingKind = 'usage' | 'subscription';

export interface ProviderMeta {
  /** Canonical id as stored in the DB / emitted by the backend. */
  id: string;
  /** Human label for filters, legends, tables. */
  label: string;
  /** Stable brand-ish color for charts/legends when a per-model color is absent. */
  color: string;
  /** Prompt-cache capability, drives the cache badges in Agent Activity. */
  cacheSupport: CacheSupport;
  /** Short note shown next to the cache badge. */
  cacheNote?: string;
  /** Upstream billing model. Absent = `usage` (metered). */
  billing?: BillingKind;
  /** Legacy / alternate ids that normalize to this provider (e.g. `gemini` → `google`). */
  aliases?: string[];
}

/**
 * The real providers Teros speaks to. Keep in sync with the adapters in
 * `@teros/core/llm` and the MCA OAuth providers. Adding a row here is the ONLY
 * place a new provider needs registering for the monitoring surface.
 */
export const PROVIDERS = {
  anthropic: { id: 'anthropic', label: 'Anthropic', color: '#3B82F6', cacheSupport: 'active', cacheNote: 'Prompt caching on' },
  'anthropic-oauth': { id: 'anthropic-oauth', label: 'Anthropic (OAuth)', color: '#3B82F6', cacheSupport: 'active', cacheNote: 'Prompt caching on', billing: 'subscription' },
  openai: { id: 'openai', label: 'OpenAI', color: '#4A9BA8', cacheSupport: 'auto', cacheNote: 'Automatic caching' },
  // Codex OAuth streams usage but the adapter never reads a cache field → `off`
  // (was `auto`, a badge that could never have data). TER-666 / A2.4.
  'openai-codex-oauth': { id: 'openai-codex-oauth', label: 'OpenAI Codex (OAuth)', color: '#4A9BA8', cacheSupport: 'off', billing: 'subscription', aliases: ['codex-oauth'] },
  'openai-compatible': { id: 'openai-compatible', label: 'OpenAI-compatible', color: '#4A9BA8', cacheSupport: 'off' },
  google: { id: 'google', label: 'Google (Gemini)', color: '#4A9E5B', cacheSupport: 'auto', cacheNote: 'Implicit caching', aliases: ['gemini'] },
  openrouter: { id: 'openrouter', label: 'OpenRouter', color: '#CF8450', cacheSupport: 'auto' },
  groq: { id: 'groq', label: 'Groq', color: '#C4713B', cacheSupport: 'off' },
  // fireworks/together/cloudflare run through OpenAICompatibleLLMAdapter, which
  // reads `prompt_tokens_details.cached_tokens` for every upstream → `auto`, not
  // `off` (the badge WILL have data). TER-666 / A2.4.
  fireworks: { id: 'fireworks', label: 'Fireworks', color: '#C4546A', cacheSupport: 'auto' },
  together: { id: 'together', label: 'Together', color: '#C4923B', cacheSupport: 'auto' },
  cloudflare: { id: 'cloudflare', label: 'Cloudflare', color: '#C4713B', cacheSupport: 'auto' },
  zhipu: { id: 'zhipu', label: 'Zhipu', color: '#7A54A6', cacheSupport: 'off' },
  'zhipu-coding': { id: 'zhipu-coding', label: 'Zhipu Coding', color: '#7A54A6', cacheSupport: 'off', billing: 'subscription' },
  minimax: { id: 'minimax', label: 'MiniMax', color: '#C4546A', cacheSupport: 'off' },
  ollama: { id: 'ollama', label: 'Ollama', color: '#6E6E7A', cacheSupport: 'off' },
  'ollama-cloud': { id: 'ollama-cloud', label: 'Ollama Cloud', color: '#6E6E7A', cacheSupport: 'off' },
  meta: { id: 'meta', label: 'Meta (Llama)', color: '#CE667A', cacheSupport: 'off' },
  mistral: { id: 'mistral', label: 'Mistral', color: '#8A66B2', cacheSupport: 'off' },
  teros: { id: 'teros', label: 'Teros', color: '#5E6AD2', cacheSupport: 'active', cacheNote: 'Managed' },
} as const satisfies Record<string, ProviderMeta>;

/** Union of the registered provider ids (derived so it cannot drift from PROVIDERS). */
export type Provider = keyof typeof PROVIDERS;

/** Alias → canonical id, built once from `aliases`. */
const ALIAS_TO_ID: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const p of Object.values(PROVIDERS) as ProviderMeta[]) {
    for (const a of p.aliases ?? []) m[a] = p.id;
  }
  return m;
})();

/**
 * Deterministic hue from an arbitrary id → HSL hex, so an UNKNOWN provider/model
 * always gets the SAME color across renders and reloads (stable identity) without
 * a registry entry. Kept out of the indigo band (230–275°) to avoid clashing with
 * the action accent.
 */
export function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  let hue = h % 360;
  if (hue >= 230 && hue <= 275) hue = (hue + 60) % 360; // dodge the indigo band
  return hslToHex(hue, 55, 60);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Resolve any provider id (canonical, alias, or unknown) to metadata. NEVER throws
 * and NEVER returns null — an unknown id degrades to `{ id, label: id, color:
 * hashColor(id), cacheSupport: 'off' }` so it still shows up in filters/legends.
 */
export function resolveProvider(id: string | null | undefined): ProviderMeta {
  if (!id) return { id: 'unknown', label: 'Unknown', color: hashColor('unknown'), cacheSupport: 'off' };
  const canonical = ALIAS_TO_ID[id] ?? id;
  const hit = (PROVIDERS as Record<string, ProviderMeta>)[canonical];
  if (hit) return hit;
  return { id, label: id, color: hashColor(id), cacheSupport: 'off' };
}

/** Stable color for a provider id (alias-aware, hashed fallback). */
export function providerColor(id: string | null | undefined): string {
  return resolveProvider(id).color;
}

/** Human label for a provider id (alias-aware, raw-id fallback). */
export function providerLabel(id: string | null | undefined): string {
  return resolveProvider(id).label;
}

/**
 * True when the provider is billed as a flat subscription (no per-token cost).
 * Alias-aware. The single source both `estimateCostUsd` (returns null, no phantom
 * cost) and the dashboard (shows "Subscription") consult. TER-666 / A2.4.
 */
export function isSubscriptionProvider(id: string | null | undefined): boolean {
  return resolveProvider(id).billing === 'subscription';
}

/**
 * Stable color for a chart/table SERIES keyed by identity (e.g.
 * `${actualProvider}::${modelId}`). Same key → same color, always; used so a
 * model keeps its color across every chart and table, and across periods.
 */
export function seriesColor(key: string): string {
  return hashColor(key);
}
