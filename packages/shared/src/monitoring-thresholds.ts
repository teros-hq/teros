/**
 * Canonical health thresholds + severity vocabulary for the Monitoring Suite
 * (TER-670 / A5.2 / A3.2).
 *
 * ONE source of truth so the same number never paints two colours on one screen:
 * before this, `ModelHealthWindow/format.ts` (fractions) and
 * `components/monitoring/colors.ts::metricTone` (percentages) disagreed — an
 * error rate of 4 % read red in the KPI and orange in the badge — and the backend
 * `agent-usage-sentry-alerts.ts` had a third set. The frontend derives its
 * warn/critical colours here; the backend pages at the CRITICAL level.
 *
 * Latency thresholds are per model CLASS: a reasoning model (Kimi/GLM/o-series)
 * runs for tens of seconds by nature, so the fixed 10 s critical made it a
 * perpetual "Incident" — a red badge that never changes stops being an alarm.
 * Rates are FRACTIONS ∈ [0,1] (the data model's unit); the "%" UI multiplies by
 * 100 at the edge.
 *
 * BE-safe: no colours, no React — importable from `@teros/core`/backend too.
 */

export type HealthLevel = "ok" | "warn" | "critical";

/** The ONE severity vocabulary. Every surface renders these words, no synonyms. */
export const LEVEL_LABELS: Record<HealthLevel, string> = {
  ok: "Healthy",
  warn: "Degraded",
  critical: "Critical",
};

const LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, critical: 2 };

/** Worst of two levels (critical > warn > ok). */
export function worseLevel(a: HealthLevel, b: HealthLevel): HealthLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Worst level across a list; `ok` for an empty list. */
export function worstLevel(levels: HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((acc, l) => worseLevel(acc, l), "ok");
}

// ---------------------------------------------------------------------------
// Latency — per model class
// ---------------------------------------------------------------------------

export type ModelClass = "reasoning" | "standard";

// A model is "reasoning" (slow by design) when its id hints at a
// reasoning/thinking family. Substring match on the lowercased id — keep the
// hints unambiguous.
const REASONING_HINTS = ["kimi", "glm", "deepseek-r", "qwq", "o1", "o3", "reason", "think"];

export function modelClass(modelId: string | undefined): ModelClass {
  const m = (modelId ?? "").toLowerCase();
  return REASONING_HINTS.some((h) => m.includes(h)) ? "reasoning" : "standard";
}

interface Band {
  warn: number;
  critical: number;
}

/** p95 latency (ms) bands by class. Reasoning models get much higher headroom. */
const LATENCY_P95_MS: Record<ModelClass, Band> = {
  standard: { warn: 4_000, critical: 10_000 },
  reasoning: { warn: 30_000, critical: 60_000 },
};
/** p95 TTFT (ms) bands by class. */
const TTFT_P95_MS: Record<ModelClass, Band> = {
  standard: { warn: 2_000, critical: 5_000 },
  reasoning: { warn: 5_000, critical: 12_000 },
};

/**
 * Level for a p95 latency/ttft value, scoped to the model's class. `null` (no
 * samples) is `ok`. Pass the modelId so a reasoning model isn't flagged just for
 * being slow by nature.
 */
export function latencyLevel(
  kind: "latency" | "ttft",
  p95: number | null,
  modelId?: string,
): HealthLevel {
  if (p95 == null || !Number.isFinite(p95)) return "ok";
  const band = (kind === "latency" ? LATENCY_P95_MS : TTFT_P95_MS)[modelClass(modelId)];
  if (p95 >= band.critical) return "critical";
  if (p95 >= band.warn) return "warn";
  return "ok";
}

/** Critical p95 latency (ms) for a model — the BE paging bar. */
export function latencyCriticalMs(kind: "latency" | "ttft", modelId?: string): number {
  return (kind === "latency" ? LATENCY_P95_MS : TTFT_P95_MS)[modelClass(modelId)].critical;
}

// ---------------------------------------------------------------------------
// Rates (fractions ∈ [0,1]) — higher is worse
// ---------------------------------------------------------------------------

export const RATE_BANDS = {
  error: { warn: 0.01, critical: 0.05 },
  saturation: { warn: 0.05, critical: 0.15 },
  fallback: { warn: 0.01, critical: 0.05 },
  toolError: { warn: 0.05, critical: 0.2 },
  truncation: { warn: 0.05, critical: 0.2 },
  empty: { warn: 0.02, critical: 0.1 },
} as const satisfies Record<string, Band>;

export type RateKind = keyof typeof RATE_BANDS;

/** Level for a "higher is worse" rate (fraction). Non-finite → ok. */
export function rateLevel(kind: RateKind, fraction: number): HealthLevel {
  if (!Number.isFinite(fraction)) return "ok";
  const band = RATE_BANDS[kind];
  if (fraction >= band.critical) return "critical";
  if (fraction >= band.warn) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// "Higher is better" metrics — success rate, feedback ratio (fractions)
// ---------------------------------------------------------------------------

const SUCCESS_BAND = { warn: 0.97, critical: 0.9 };
const FEEDBACK_BAND = { warn: 0.9, critical: 0.85 };

/** Level for a "higher is better" fraction against a band (below warn → warn…). */
function goodnessLevel(fraction: number, band: Band): HealthLevel {
  if (!Number.isFinite(fraction)) return "ok";
  if (fraction < band.critical) return "critical";
  if (fraction < band.warn) return "warn";
  return "ok";
}

export const successLevel = (fraction: number): HealthLevel => goodnessLevel(fraction, SUCCESS_BAND);
export const feedbackLevel = (fraction: number): HealthLevel =>
  goodnessLevel(fraction, FEEDBACK_BAND);
