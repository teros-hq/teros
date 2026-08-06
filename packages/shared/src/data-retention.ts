/**
 * Data Retention Classification
 *
 * SINGLE SOURCE OF TRUTH for the data-retention / training posture of every
 * LLM provider Teros can connect to. Consumed by:
 *   - backend: `provider.list-models` enriches each model with `retention`
 *   - frontend: the model/provider picker renders a badge + an inline notice
 *     so the user knows what happens to their data BEFORE choosing a model.
 *
 * The posture is essentially a property of the PROVIDER (with a few
 * config-dependent nuances), not of the individual model — so it is keyed by
 * provider here and resolved per model via {@link resolveRetention}.
 *
 * SCOPE OF THE CLAIM: this describes what the **model/inference provider** does
 * with your prompts (retention + training). It says NOTHING about whether the
 * Teros platform itself persists your conversation — it always does (messages,
 * memory, files live in MongoDB regardless of which model you pick). Notice
 * copy must stay scoped to the inference provider, never imply the platform
 * doesn't store anything.
 *
 * Two distinct axes (do not conflate):
 *   - retention  = how long inputs/outputs are stored
 *   - training   = whether they are used to improve the model
 * A provider can avoid training yet still retain (e.g. 30 days for abuse).
 *
 * Classification verified against official policies on {@link RETENTION_VERIFIED_AT}.
 *
 * NOTE: provider policies change — `data-retention.test.ts` fails if this date
 * goes stale, forcing a re-audit. Keep it in sync when you re-verify.
 */

/** Date (ISO `YYYY-MM-DD`) the classification was last verified against official
 * sources. A guard test fails when this is older than the allowed window. */
export const RETENTION_VERIFIED_AT = '2026-06-26';

/**
 * Risk tier shown to the user, ordered by data-privacy risk.
 *
 * - `zdr`     — Zero Data Retention: the model provider does not train on or
 *               store your prompts (or stores them only in volatile memory for
 *               the request). Safe for sensitive data.
 * - `retains` — Not trained on by default, but inputs/outputs ARE stored for a
 *               period, OR the posture depends on the user's own configuration
 *               (paid tier, ZDR filter, account toggle).
 * - `trains`  — Trained on by default (consumer subscriptions) OR opaque policy
 *               / risky jurisdiction. Discouraged for sensitive data without an
 *               explicit opt-out.
 */
export type RetentionTier = 'zdr' | 'retains' | 'trains';

export interface RetentionInfo {
  /** Risk tier — drives the badge colour and whether a notice is shown. */
  tier: RetentionTier;
  /**
   * Discriminant for the provider-specific notice. The frontend composes the
   * i18n key as `dataRetention.notice.<noticeSlug>` — the backend stays free of
   * UI/i18n namespace coupling (it ships the slug, not a presentation path).
   */
  noticeSlug: string;
}

const ZDR: RetentionInfo = { tier: 'zdr', noticeSlug: 'zdr' };

/**
 * Per-provider retention posture. Keys are the `provider` field of the model
 * catalog (see packages/backend/src/types/database.ts → Model.provider).
 */
export const PROVIDER_RETENTION: Record<string, RetentionInfo> = {
  // 🟢 Zero Data Retention by default — no training, nothing stored.
  teros: ZDR, // Teros official provider (Kimi via Fireworks AI, ZDR by default)
  fireworks: ZDR,
  'ollama-cloud': ZDR,
  cloudflare: ZDR,
  // Local inference — data never leaves the user's machine (ZDR by construction).
  ollama: { tier: 'zdr', noticeSlug: 'local' },

  // 🟡 No training by default, but data IS retained or the posture depends on config.
  // Anthropic/OpenAI APIs: no training, 30-day abuse retention, ZDR only via enterprise agreement.
  anthropic: { tier: 'retains', noticeSlug: 'api30d' },
  openai: { tier: 'retains', noticeSlug: 'api30d' },
  // Groq: does not train, but retains abuse/error logs ~30 days by default; full
  // ZDR requires opting in via Data Controls. Same posture as the paid APIs above.
  groq: { tier: 'retains', noticeSlug: 'groq' },
  // OpenRouter is a passthrough — retention depends on the upstream provider; offers a ZDR filter.
  openrouter: { tier: 'retains', noticeSlug: 'openrouter' },
  // Together: retains by default, but ZDR is opt-in per account and that
  // account-level toggle is ENABLED for our org (confirmed 2026-06-30). This is
  // what unlocks the teros→Together failover (TER-617/F3) — the resolver's ZDR
  // guard only routes here while this is `zdr`. ⚠️ Compliance dependency: it
  // holds ONLY while that toggle stays on (not API-verifiable). If Together's
  // account ZDR is ever disabled, revert this to `retains` — the guard will
  // then make the failover inert again. (Training axis was always safe: Kimi is
  // open-weight / post-cutoff.)
  together: { tier: 'zdr', noticeSlug: 'zdr' },
  // Z.ai (Singapore) default: API content not stored, no training on content; non-EU jurisdiction.
  zhipu: { tier: 'retains', noticeSlug: 'zhipu' },
  'zhipu-coding': { tier: 'retains', noticeSlug: 'zhipu' },
  // Gemini: paid tier does not use your data; free AI Studio tier does (+ human review).
  // The tier cannot be determined from the API key, so warn with the actionable nuance.
  google: { tier: 'retains', noticeSlug: 'google' },

  // 🔴 Trained on by default, or opaque policy / risky jurisdiction.
  // Consumer subscriptions train on your conversations by default (opt-out only).
  'anthropic-oauth': { tier: 'trains', noticeSlug: 'anthropicConsumer' },
  'openai-codex-oauth': { tier: 'trains', noticeSlug: 'openaiConsumer' },
  // MiniMax: policy does not address training at all; storage location undeclared, PRC parent.
  minimax: { tier: 'trains', noticeSlug: 'minimax' },
};

/** Fallback for a provider not present in {@link PROVIDER_RETENTION}. */
const UNKNOWN_RETENTION: RetentionInfo = {
  tier: 'retains',
  noticeSlug: 'unknown',
};

/** Zhipu routed to the China endpoint (open.bigmodel.cn): data stored in China
 * under PRC law + trained on with anonymized data. Strictly worse than z.ai. */
const ZHIPU_CHINA: RetentionInfo = {
  tier: 'trains',
  noticeSlug: 'zhipuChina',
};

/**
 * Resolve the retention posture for a model, taking config-dependent nuances
 * into account. Pass the model's `providerConfig` when available.
 *
 * Nuances handled:
 *   - `zhipu` / `zhipu-coding` with `providerConfig.useChina === true` → routed
 *     to open.bigmodel.cn (China) → strictly worse than the z.ai default.
 *
 * Unknown providers fail safe to `retains` (never `zdr` — we won't promise
 * Zero Data Retention for a provider we have not classified).
 */
export function resolveRetention(
  provider: string,
  providerConfig?: Record<string, unknown> | null,
): RetentionInfo {
  if ((provider === 'zhipu' || provider === 'zhipu-coding') && providerConfig?.useChina === true) {
    return ZHIPU_CHINA;
  }
  return PROVIDER_RETENTION[provider] ?? UNKNOWN_RETENTION;
}

/** `true` when the posture warrants an inline notice (anything that is not ZDR). */
export function retentionNeedsNotice(info: RetentionInfo): boolean {
  return info.tier !== 'zdr';
}
