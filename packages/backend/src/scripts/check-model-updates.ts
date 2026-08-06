/**
 * Check Model Updates Script
 *
 * Detects drift between our curated model catalog (src/models/providers/*.ts)
 * and upstream reality. Read-only: it NEVER writes to the catalog or the DB —
 * adding/retiring models remains a human decision (the catalog is curated).
 *
 * Sources:
 * - Primary: https://models.dev/api.json (no auth)
 * - Pricing cross-check: LiteLLM model_prices_and_context_window.json
 *   (NOTE: LiteLLM is USD/token — multiply by 1e6 to compare with our USD/1M)
 * - For the `openrouter` provider, https://openrouter.ai/api/v1/models is the
 *   authoritative source (live catalog); models.dev is kept as annotation.
 *
 * Report sections:
 * 1. NEW: relevant upstream models we don't have, with a ready-to-paste
 *    TypeScript ModelDefinition snippet following the provider file pattern.
 *    "Relevant" = agentic (tool calling + real context + text output) and
 *    recently released (--new-days window; --all-new lifts the recency filter).
 * 2. DRIFT: field-by-field differences on existing active models.
 * 3. RETIRED: active models in Teros that upstream deprecates or no longer lists.
 *
 * Only comparable fields are checked: context limits, cost, vision/thinking/tools
 * capabilities, and upstream status. Internal fields (modelId, name, description,
 * defaults, reservations, compaction, billingType, quota) are never compared.
 *
 * Deliberate exclusions (see CLAUDE.md / fase 1 notes):
 * - `teros` (own-margin pricing), `groq` (disabled, no adapter), `ollama`
 *   (runtime discovery via /api/tags) are not mapped to any upstream source.
 * - OAuth providers (`anthropic-oauth`, `openai-codex-oauth`) have PLAN limits,
 *   deliberately different from the API model limits — context is not compared.
 * - `google` models carry `thinking: false` on purpose (adapter limitation) —
 *   thinking is not compared for that provider.
 * - `ollama-cloud` ids in models.dev don't carry the real tags; matching strips
 *   the `:cloud`/`-cloud` suffix and unmatched models are reported as
 *   "not verifiable" (check ollama.com/library/<model>/tags manually).
 *
 * Usage:
 *   yarn workspace @teros/backend check-models [options]
 *
 * Options:
 *   --json           Machine-readable output (for the phase-3 cron)
 *   --all-new        Don't filter NEW models by release date
 *   --new-days N     Recency window for NEW models (default: 90)
 *   --provider X     Only check one Teros provider (e.g. fireworks)
 */

import { MODEL_DEFINITIONS } from "../models/definitions"
import type { ModelDefinition } from "../models/types"

// ============================================================================
// TYPES
// ============================================================================

export interface UpstreamModel {
  id: string
  name?: string
  description?: string
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

export type ModelsDevData = Record<string, { models: Record<string, UpstreamModel> }>

/** LiteLLM entry — costs are USD per TOKEN (×1e6 for USD/1M) */
export interface LiteLlmEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  max_input_tokens?: number
  max_output_tokens?: number
}

export interface OpenRouterApiModel {
  id: string
  context_length?: number
  top_provider?: { context_length?: number; max_completion_tokens?: number | null }
  pricing?: { prompt?: string; completion?: string }
}

export interface Sources {
  modelsDev: ModelsDevData
  litellm?: Record<string, LiteLlmEntry> | null
  openrouterApi?: OpenRouterApiModel[] | null
}

export interface CheckOptions {
  json?: boolean
  allNew?: boolean
  newDays?: number
  provider?: string
  /** Injectable clock for tests (defaults to now) */
  now?: Date
}

export interface FieldDrift {
  field: string
  ours: unknown
  upstream: unknown
  note?: string
}

export interface DriftFinding {
  modelId: string
  provider: string
  modelString: string
  upstreamId: string
  fields: FieldDrift[]
}

export interface NewModelFinding {
  providerKey: string
  terosProvider: string
  id: string
  name: string
  releaseDate?: string
  snippet: string
}

export interface RetiredFinding {
  modelId: string
  provider: string
  modelString: string
  reason: "deprecated-upstream" | "missing-upstream"
  note?: string
}

export interface SkippedEntry {
  modelId: string
  provider: string
  reason: string
}

export interface Report {
  meta: {
    checkedAt: string
    sources: { modelsDev: boolean; litellm: boolean; openrouterApi: boolean }
    providersChecked: string[]
    providersExcluded: string[]
    /** NEW models omitted per models.dev key by the recency filter */
    omittedNew: Record<string, number>
    /** Upstream models per key that are never candidates (no tools/context/text) */
    nonAgenticSkipped: Record<string, number>
    hasFindings: boolean
  }
  newModels: NewModelFinding[]
  drift: DriftFinding[]
  retired: RetiredFinding[]
  skipped: SkippedEntry[]
}

// ============================================================================
// CONFIG
// ============================================================================

/** Teros provider → models.dev provider key */
export const PROVIDER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  "anthropic-oauth": "anthropic",
  openai: "openai",
  "openai-codex-oauth": "openai",
  google: "google",
  zhipu: "zai",
  "zhipu-coding": "zai-coding-plan",
  openrouter: "openrouter",
  minimax: "minimax",
  fireworks: "fireworks-ai",
  together: "togetherai",
  cloudflare: "cloudflare-workers-ai",
  "ollama-cloud": "ollama-cloud",
}

/** Deliberately not synced against any upstream source */
export const EXCLUDED_PROVIDERS: Record<string, string> = {
  teros: "own-margin pricing, curated by hand",
  groq: "disabled, no adapter",
  ollama: "local models, runtime discovery via /api/tags",
}

/** Plan-level limits, deliberately different from the API model limits */
const OAUTH_PROVIDERS = new Set(["anthropic-oauth", "openai-codex-oauth"])

/** modelId prefix convention per Teros provider (for generated snippets) */
const MODEL_ID_PREFIX: Record<string, string> = {
  fireworks: "fireworks-",
  together: "together-",
  cloudflare: "cloudflare-",
  openrouter: "openrouter-",
  "ollama-cloud": "ollama-cloud-",
}

const NAME_SUFFIX: Record<string, string> = {
  fireworks: " (Fireworks)",
  together: " (Together)",
  cloudflare: " (Cloudflare)",
  openrouter: " (OpenRouter)",
  "ollama-cloud": " (Ollama Cloud)",
}

/** models.dev key → Teros provider used for NEW-model snippets */
const SNIPPET_PROVIDER: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  zai: "zhipu",
  "zai-coding-plan": "zhipu-coding",
  openrouter: "openrouter",
  minimax: "minimax",
  "fireworks-ai": "fireworks",
  togetherai: "together",
  "cloudflare-workers-ai": "cloudflare",
  "ollama-cloud": "ollama-cloud",
}

/** LiteLLM lookup key prefixes per Teros provider */
const LITELLM_PREFIXES: Record<string, string[]> = {
  anthropic: [""],
  "anthropic-oauth": [""],
  openai: [""],
  "openai-codex-oauth": [""],
  google: ["gemini/", ""],
  zhipu: ["", "zhipu/"],
  "zhipu-coding": ["", "zhipu/"],
  openrouter: ["openrouter/"],
  minimax: ["", "minimax/"],
  fireworks: ["fireworks_ai/"],
  together: ["together_ai/"],
  cloudflare: ["cloudflare/"],
}

const DEFAULT_NEW_DAYS = 90
/** Relative tolerance for cost comparisons (rounding noise between sources) */
const COST_TOLERANCE = 0.005
/**
 * Relative tolerance for context limits — swallows the permanent decimal vs
 * binary convention noise (1000000 vs 1048576, 200000 vs 204800, 128000 vs
 * 131072). Real limit changes upstream are 2x+ jumps and still get reported.
 */
const CONTEXT_TOLERANCE = 0.05

const MODELS_DEV_URL = "https://models.dev/api.json"
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models"

// ============================================================================
// MATCHING HELPERS
// ============================================================================

/** "claude-opus-4-5-20251101" → "claude-opus-4-5" */
export function stripDateSuffix(id: string): string {
  return id.replace(/-\d{8}$/, "")
}

/** "glm-5.2:cloud" → "glm-5.2" · "deepseek-v3.1:671b-cloud" → "deepseek-v3.1:671b" */
export function stripCloudSuffix(id: string): string {
  return id.replace(/:cloud$/, "").replace(/-cloud$/, "")
}

/** Lookup candidates for a Teros model against a models.dev provider index */
export function lookupCandidates(provider: string, modelString: string): string[] {
  const candidates = [modelString]
  if (provider === "anthropic" || provider === "anthropic-oauth") {
    const stripped = stripDateSuffix(modelString)
    if (stripped !== modelString) candidates.push(stripped)
  }
  if (provider === "ollama-cloud") {
    const stripped = stripCloudSuffix(modelString)
    if (stripped !== modelString) candidates.push(stripped)
  }
  return candidates
}

function matchUpstream(
  model: ModelDefinition,
  index: Record<string, UpstreamModel>,
): UpstreamModel | null {
  for (const candidate of lookupCandidates(model.provider, model.modelString)) {
    const found = index[candidate]
    if (found) return found
  }
  return null
}

/** Models we knowingly can't check against upstream (returns the reason) */
export function skipReason(model: ModelDefinition): string | null {
  if (
    model.provider === "fireworks" &&
    model.modelString.startsWith("accounts/fireworks/routers/")
  ) {
    return "Fireworks router variant — not listed in models.dev"
  }
  if (model.provider === "openrouter" && model.modelString === "openrouter/auto") {
    return "OpenRouter routing meta-model — no limits of its own"
  }
  return null
}

// ============================================================================
// DIFFING
// ============================================================================

/** Round to 6 decimals — kills float noise from USD/token → USD/1M conversions */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function numbersDiffer(ours: number, upstream: number, tolerance = COST_TOLERANCE): boolean {
  if (ours === upstream) return false
  const base = Math.max(Math.abs(ours), Math.abs(upstream))
  return base === 0 ? false : Math.abs(ours - upstream) / base > tolerance
}

function contextDiffers(ours: number, upstream: number): boolean {
  return numbersDiffer(ours, upstream, CONTEXT_TOLERANCE)
}

function diffContext(model: ModelDefinition, upstream: UpstreamModel): FieldDrift[] {
  if (OAUTH_PROVIDERS.has(model.provider)) return []
  const fields: FieldDrift[] = []
  const limit = upstream.limit
  if (
    typeof limit?.context === "number" &&
    contextDiffers(model.context.maxTokens, limit.context)
  ) {
    fields.push({
      field: "context.maxTokens",
      ours: model.context.maxTokens,
      upstream: limit.context,
    })
  }
  if (
    typeof limit?.output === "number" &&
    contextDiffers(model.context.maxOutputTokens, limit.output)
  ) {
    fields.push({
      field: "context.maxOutputTokens",
      ours: model.context.maxOutputTokens,
      upstream: limit.output,
    })
  }
  return fields
}

function diffCost(model: ModelDefinition, upstream: UpstreamModel): FieldDrift[] {
  if (!model.cost || !upstream.cost) return []
  const fields: FieldDrift[] = []
  const pairs: Array<[string, number | undefined, number | undefined]> = [
    ["cost.input", model.cost.input, upstream.cost.input],
    ["cost.output", model.cost.output, upstream.cost.output],
    ["cost.cacheRead", model.cost.cacheRead, upstream.cost.cache_read],
  ]
  for (const [field, ours, up] of pairs) {
    if (typeof ours === "number" && typeof up === "number" && numbersDiffer(ours, up)) {
      fields.push({ field, ours, upstream: up })
    }
  }
  return fields
}

function diffCapabilities(model: ModelDefinition, upstream: UpstreamModel): FieldDrift[] {
  const fields: FieldDrift[] = []
  const upstreamVision = upstream.modalities?.input?.includes("image") ?? false
  if (model.capabilities.vision !== upstreamVision) {
    fields.push({
      field: "capabilities.vision",
      ours: model.capabilities.vision,
      upstream: upstreamVision,
    })
  }
  // google carries thinking: false on purpose (adapter limitation)
  if (model.provider !== "google" && typeof upstream.reasoning === "boolean") {
    const ourThinking = model.capabilities.thinking ?? false
    if (ourThinking !== upstream.reasoning) {
      fields.push({
        field: "capabilities.thinking",
        ours: ourThinking,
        upstream: upstream.reasoning,
      })
    }
  }
  if (typeof upstream.tool_call === "boolean" && model.capabilities.tools !== upstream.tool_call) {
    fields.push({
      field: "capabilities.tools",
      ours: model.capabilities.tools,
      upstream: upstream.tool_call,
    })
  }
  return fields
}

/** Field-by-field drift for one model against its matched models.dev entry */
export function diffModel(model: ModelDefinition, upstream: UpstreamModel): FieldDrift[] {
  return [
    ...diffContext(model, upstream),
    ...diffCost(model, upstream),
    ...diffCapabilities(model, upstream),
  ]
}

/** Drift for openrouter models against the live OpenRouter API (authoritative) */
export function diffOpenRouterApi(model: ModelDefinition, api: OpenRouterApiModel): FieldDrift[] {
  const fields: FieldDrift[] = []
  if (
    typeof api.context_length === "number" &&
    contextDiffers(model.context.maxTokens, api.context_length)
  ) {
    fields.push({
      field: "context.maxTokens",
      ours: model.context.maxTokens,
      upstream: api.context_length,
    })
  }
  const maxOut = api.top_provider?.max_completion_tokens
  if (typeof maxOut === "number" && contextDiffers(model.context.maxOutputTokens, maxOut)) {
    fields.push({
      field: "context.maxOutputTokens",
      ours: model.context.maxOutputTokens,
      upstream: maxOut,
    })
  }
  if (model.cost && api.pricing) {
    const prompt = round6(Number(api.pricing.prompt) * 1e6)
    const completion = round6(Number(api.pricing.completion) * 1e6)
    if (Number.isFinite(prompt) && numbersDiffer(model.cost.input, prompt)) {
      fields.push({ field: "cost.input", ours: model.cost.input, upstream: prompt })
    }
    if (Number.isFinite(completion) && numbersDiffer(model.cost.output, completion)) {
      fields.push({ field: "cost.output", ours: model.cost.output, upstream: completion })
    }
  }
  return fields
}

// ============================================================================
// LITELLM CROSS-CHECK (USD/token → ×1e6)
// ============================================================================

export function litellmLookup(
  litellm: Record<string, LiteLlmEntry>,
  provider: string,
  modelString: string,
): LiteLlmEntry | null {
  for (const prefix of LITELLM_PREFIXES[provider] ?? []) {
    const entry = litellm[`${prefix}${modelString}`]
    if (entry) return entry
  }
  return null
}

const LITELLM_NOTES: Record<string, (e: LiteLlmEntry) => number | undefined> = {
  "cost.input": (e) =>
    typeof e.input_cost_per_token === "number" ? e.input_cost_per_token * 1e6 : undefined,
  "cost.output": (e) =>
    typeof e.output_cost_per_token === "number" ? e.output_cost_per_token * 1e6 : undefined,
  "cost.cacheRead": (e) =>
    typeof e.cache_read_input_token_cost === "number"
      ? e.cache_read_input_token_cost * 1e6
      : undefined,
  "context.maxTokens": (e) => e.max_input_tokens,
  "context.maxOutputTokens": (e) => e.max_output_tokens,
}

/** Annotate drift fields with the LiteLLM value as a second opinion */
export function annotateWithLitellm(fields: FieldDrift[], entry: LiteLlmEntry): FieldDrift[] {
  return fields.map((f) => {
    const value = LITELLM_NOTES[f.field]?.(entry)
    if (value === undefined) return f
    const rounded = Math.round(value * 1000) / 1000
    return { ...f, note: `LiteLLM: ${rounded}` }
  })
}

// ============================================================================
// SNIPPET GENERATION
// ============================================================================

/**
 * Compaction settings for a generated snippet. On large contexts (>= 500K) the
 * trigger must leave more headroom than maxOutputTokens (glm-5.2 pattern:
 * 850000 for 1M/131K). Smaller contexts follow the catalog's 0.75 ratio
 * (200K/64K → 150000), which deliberately doesn't apply the headroom rule.
 */
export function deriveCompaction(
  maxTokens: number,
  maxOutputTokens: number,
  protectRecent: number,
): { triggerAt: number; targetSize: number; protectRecent: number } {
  const large = maxTokens >= 500_000
  const step = maxTokens >= 100_000 ? 10_000 : 1_000
  const roundDown = (n: number) => Math.floor(n / step) * step
  let triggerAt = roundDown(maxTokens * (large ? 0.85 : 0.75))
  if (large && maxTokens - triggerAt <= maxOutputTokens) {
    triggerAt = roundDown(maxTokens - maxOutputTokens - 10_000)
  }
  // cap by the trigger too: when the headroom clamp pulls the trigger down a
  // lot (huge maxOutputTokens), ctx-based targets would land right next to it
  // and compaction would free almost nothing
  const targetSize = Math.min(
    roundDown(maxTokens * (large ? 0.6 : 0.5)),
    roundDown(triggerAt * 0.75),
  )
  return { triggerAt, targetSize, protectRecent }
}

/** Derive a catalog modelId from an upstream id, following each file's convention */
export function deriveModelId(terosProvider: string, upstreamId: string): string {
  const lastSegment = upstreamId.split("/").pop() ?? upstreamId
  let base = stripDateSuffix(lastSegment.toLowerCase())
  if (terosProvider === "ollama-cloud") base = stripCloudSuffix(base)
  base = base.replace(/[:@]/g, "-")
  if (terosProvider === "zhipu-coding") return `${base}-coding`
  const prefix = MODEL_ID_PREFIX[terosProvider] ?? ""
  return base.startsWith(prefix) ? base : `${prefix}${base}`
}

function firstSentence(text: string, maxLength = 180): string {
  const period = text.indexOf(". ")
  const sentence = period > 0 ? text.slice(0, period + 1) : text
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trimEnd()}…` : sentence
}

function templateFor(
  catalog: ModelDefinition[],
  terosProvider: string,
): ModelDefinition | undefined {
  const models = catalog.filter((m) => m.provider === terosProvider)
  // prefer a cost-tracking template: on usage-billing providers the snippet
  // must carry cost even if the file's first model doesn't define it
  return (
    models.find((m) => m.status === "active" && m.cost) ??
    models.find((m) => m.status === "active") ??
    models[0]
  )
}

function snippetCapabilities(upstream: UpstreamModel, terosProvider: string): string[] {
  // strict comparisons: upstream JSON is untrusted, only real booleans may
  // reach the emitted code (anything else would interpolate verbatim)
  const vision = upstream.modalities?.input?.includes("image") === true
  // google adapters don't support thinking yet — keep the deliberate false
  const thinking = terosProvider === "google" ? false : upstream.reasoning === true
  return [
    "    capabilities: {",
    "      streaming: true,",
    `      tools: ${upstream.tool_call !== false},`,
    `      vision: ${vision},`,
    `      thinking: ${thinking},`,
    "    },",
  ]
}

function snippetCost(upstream: UpstreamModel, template: ModelDefinition): string[] {
  // only providers whose catalog file tracks cost (e.g. fireworks/together) get it
  if (!template.cost || !upstream.cost) return []
  const lines = [
    "    cost: {",
    `      input: ${Number(upstream.cost.input)},`,
    `      output: ${Number(upstream.cost.output)},`,
  ]
  if (typeof upstream.cost.cache_read === "number")
    lines.push(`      cacheRead: ${Number(upstream.cost.cache_read)},`)
  lines.push("    },")
  return lines
}

/**
 * Ready-to-paste ModelDefinition snippet following the provider file pattern.
 * Defaults/reservations/compaction are inherited from an existing model of the
 * same provider (compaction is recalculated when the context size differs).
 */
export function generateSnippet(
  upstream: UpstreamModel,
  terosProvider: string,
  template: ModelDefinition,
): string {
  // Number() the untrusted limits: a non-numeric value becomes NaN, which
  // fails loud in the snippet and is rejected by the catalog invariants test
  const maxTokens = Number(upstream.limit?.context ?? template.context.maxTokens)
  const maxOutputTokens = Number(upstream.limit?.output ?? template.context.maxOutputTokens)
  const compaction =
    maxTokens === template.context.maxTokens
      ? template.compaction
      : deriveCompaction(maxTokens, maxOutputTokens, template.compaction.protectRecent)
  const name = `${upstream.name ?? upstream.id}${NAME_SUFFIX[terosProvider] ?? ""}`
  const description = upstream.description
    ? firstSentence(upstream.description)
    : `${upstream.name ?? upstream.id} via ${terosProvider}.`

  return [
    "  {",
    // JSON.stringify every upstream-controlled string: it escapes quotes,
    // backslashes, and newlines, so untrusted content can never break out of
    // the emitted string literal into code
    `    modelId: ${JSON.stringify(deriveModelId(terosProvider, upstream.id))},`,
    `    provider: ${JSON.stringify(terosProvider)},`,
    `    name: ${JSON.stringify(name)},`,
    `    description: ${JSON.stringify(description)},`,
    `    modelString: ${JSON.stringify(upstream.id)},`,
    ...snippetCapabilities(upstream, terosProvider),
    "    context: {",
    `      maxTokens: ${maxTokens},`,
    `      maxOutputTokens: ${maxOutputTokens},`,
    "    },",
    "    defaults: {",
    `      temperature: ${template.defaults.temperature},`,
    `      maxTokens: ${template.defaults.maxTokens},`,
    "    },",
    "    reservations: {",
    `      systemPrompt: ${template.reservations.systemPrompt},`,
    `      memory: ${template.reservations.memory},`,
    `      output: ${template.reservations.output},`,
    "    },",
    "    compaction: {",
    `      triggerAt: ${compaction.triggerAt},`,
    `      targetSize: ${compaction.targetSize},`,
    `      protectRecent: ${compaction.protectRecent},`,
    "    },",
    ...snippetCost(upstream, template),
    '    status: "active",',
    "  },",
  ].join("\n")
}

// ============================================================================
// NEW MODELS
// ============================================================================

function isRecent(upstream: UpstreamModel, cutoff: Date): boolean {
  if (!upstream.release_date) return false
  const released = new Date(upstream.release_date)
  return !Number.isNaN(released.getTime()) && released >= cutoff
}

/**
 * Teros agents need tool calling, a real context window, and text output —
 * image/audio/embedding upstream models are never catalog candidates.
 */
export function isAgentic(upstream: UpstreamModel): boolean {
  return (
    upstream.tool_call === true &&
    (upstream.limit?.context ?? 0) > 0 &&
    (upstream.modalities?.output ?? ["text"]).includes("text")
  )
}

interface NewModelsResult {
  findings: NewModelFinding[]
  omitted: number
  nonAgentic: number
}

/** All upstream ids covered by our catalog models (including match variants) */
function coveredIds(terosModels: ModelDefinition[]): Set<string> {
  const covered = new Set<string>()
  for (const model of terosModels) {
    for (const candidate of lookupCandidates(model.provider, model.modelString)) {
      covered.add(candidate)
      covered.add(stripDateSuffix(candidate))
    }
  }
  return covered
}

/** Uncovered, non-deprecated upstream models, deduped dated/undated (prefer undated) */
function uncoveredUpstream(
  upstreamIndex: Record<string, UpstreamModel>,
  covered: Set<string>,
): UpstreamModel[] {
  const byNormalized = new Map<string, UpstreamModel>()
  for (const upstream of Object.values(upstreamIndex)) {
    if (upstream.status === "deprecated") continue
    if (covered.has(upstream.id) || covered.has(stripDateSuffix(upstream.id))) continue
    const normalized = stripDateSuffix(upstream.id)
    const existing = byNormalized.get(normalized)
    if (!existing || upstream.id === normalized) byNormalized.set(normalized, upstream)
  }
  return [...byNormalized.values()]
}

/** Upstream models (per models.dev key) not present in our catalog */
export function findNewModels(
  providerKey: string,
  terosModels: ModelDefinition[],
  upstreamIndex: Record<string, UpstreamModel>,
  catalog: ModelDefinition[],
  opts: CheckOptions,
): NewModelsResult {
  const candidates = uncoveredUpstream(upstreamIndex, coveredIds(terosModels))

  const cutoffMs =
    (opts.now ?? new Date()).getTime() - (opts.newDays ?? DEFAULT_NEW_DAYS) * 86_400_000
  const cutoff = new Date(cutoffMs)

  const terosProvider = SNIPPET_PROVIDER[providerKey]
  const template = templateFor(catalog, terosProvider)
  const findings: NewModelFinding[] = []
  let omitted = 0
  let nonAgentic = 0
  for (const upstream of candidates) {
    if (!isAgentic(upstream)) {
      nonAgentic++
      continue
    }
    if (!opts.allNew && !isRecent(upstream, cutoff)) {
      omitted++
      continue
    }
    findings.push({
      providerKey,
      terosProvider,
      id: upstream.id,
      name: upstream.name ?? upstream.id,
      releaseDate: upstream.release_date,
      snippet: template ? generateSnippet(upstream, terosProvider, template) : "",
    })
  }
  findings.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
  return { findings, omitted, nonAgentic }
}

// ============================================================================
// REPORT
// ============================================================================

function pushRetired(
  report: Report,
  model: ModelDefinition,
  reason: RetiredFinding["reason"],
  note?: string,
): void {
  const finding: RetiredFinding = {
    modelId: model.modelId,
    provider: model.provider,
    modelString: model.modelString,
    reason,
  }
  if (note) finding.note = note
  report.retired.push(finding)
}

function pushDrift(
  report: Report,
  model: ModelDefinition,
  upstreamId: string,
  fields: FieldDrift[],
): void {
  if (fields.length === 0) return
  report.drift.push({
    modelId: model.modelId,
    provider: model.provider,
    modelString: model.modelString,
    upstreamId,
    fields,
  })
}

/** openrouter: the live API is authoritative for drift and retirement */
function checkAgainstOpenRouterApi(
  model: ModelDefinition,
  openrouterApi: OpenRouterApiModel[],
  report: Report,
): void {
  const api = openrouterApi.find((m) => m.id === model.modelString)
  if (!api) {
    pushRetired(report, model, "missing-upstream", "Not listed in the live OpenRouter API")
    return
  }
  pushDrift(report, model, api.id, diffOpenRouterApi(model, api))
}

function checkAgainstModelsDev(
  model: ModelDefinition,
  upstreamIndex: Record<string, UpstreamModel>,
  sources: Sources,
  report: Report,
): void {
  const upstream = matchUpstream(model, upstreamIndex)
  if (!upstream) {
    const note =
      model.provider === "ollama-cloud"
        ? `models.dev doesn't carry real tags — verify at https://ollama.com/library/${stripCloudSuffix(model.modelString).split(":")[0]}/tags`
        : undefined
    pushRetired(report, model, "missing-upstream", note)
    return
  }
  if (upstream.status === "deprecated") {
    pushRetired(report, model, "deprecated-upstream")
    return
  }

  let fields = diffModel(model, upstream)
  if (fields.length > 0 && sources.litellm) {
    const entry = litellmLookup(sources.litellm, model.provider, model.modelString)
    if (entry) fields = annotateWithLitellm(fields, entry)
  }
  pushDrift(report, model, upstream.id, fields)
}

function checkOneModel(
  model: ModelDefinition,
  upstreamIndex: Record<string, UpstreamModel>,
  sources: Sources,
  report: Report,
): void {
  const skip = skipReason(model)
  if (skip) {
    report.skipped.push({ modelId: model.modelId, provider: model.provider, reason: skip })
    return
  }
  if (model.provider === "openrouter" && sources.openrouterApi) {
    checkAgainstOpenRouterApi(model, sources.openrouterApi, report)
    return
  }
  checkAgainstModelsDev(model, upstreamIndex, sources, report)
}

/**
 * NEW models are computed once per models.dev key (the "anthropic" key covers
 * both the anthropic and anthropic-oauth catalogs, etc.)
 */
function collectNewModels(
  catalog: ModelDefinition[],
  sources: Sources,
  report: Report,
  opts: CheckOptions,
): void {
  const checkedKeys = new Map<string, ModelDefinition[]>()
  for (const provider of report.meta.providersChecked) {
    const key = PROVIDER_MAP[provider]
    const group = checkedKeys.get(key) ?? []
    group.push(...catalog.filter((m) => m.provider === provider))
    checkedKeys.set(key, group)
  }
  for (const [key, terosModels] of checkedKeys) {
    const { findings, omitted, nonAgentic } = findNewModels(
      key,
      terosModels,
      sources.modelsDev[key].models,
      catalog,
      opts,
    )
    report.newModels.push(...findings)
    if (omitted > 0) report.meta.omittedNew[key] = omitted
    if (nonAgentic > 0) report.meta.nonAgenticSkipped[key] = nonAgentic
  }
}

/** Pure report builder — sources are injected so tests can use fixtures */
export function buildReport(
  catalog: ModelDefinition[],
  sources: Sources,
  opts: CheckOptions = {},
): Report {
  const report: Report = {
    meta: {
      checkedAt: (opts.now ?? new Date()).toISOString(),
      sources: {
        modelsDev: true,
        litellm: Boolean(sources.litellm),
        openrouterApi: Boolean(sources.openrouterApi),
      },
      providersChecked: [],
      providersExcluded: [],
      omittedNew: {},
      nonAgenticSkipped: {},
      hasFindings: false,
    },
    newModels: [],
    drift: [],
    retired: [],
    skipped: [],
  }

  const providers = [...new Set(catalog.map((m) => m.provider))].filter(
    (p) => !opts.provider || p === opts.provider,
  )

  for (const provider of providers) {
    if (!(provider in PROVIDER_MAP)) {
      report.meta.providersExcluded.push(provider)
      continue
    }
    const providerKey = PROVIDER_MAP[provider]
    const upstreamIndex = sources.modelsDev[providerKey]?.models
    if (!upstreamIndex) {
      report.meta.providersExcluded.push(`${provider} (no "${providerKey}" key in models.dev)`)
      continue
    }
    report.meta.providersChecked.push(provider)

    const activeModels = catalog.filter((m) => m.provider === provider && m.status === "active")
    for (const model of activeModels) {
      checkOneModel(model, upstreamIndex, sources, report)
    }
  }

  collectNewModels(catalog, sources, report, opts)

  report.meta.hasFindings =
    report.newModels.length > 0 || report.drift.length > 0 || report.retired.length > 0
  return report
}

// ============================================================================
// OUTPUT
// ============================================================================

function printNewModels(report: Report): void {
  console.log(`\n🆕 NEW upstream models not in the catalog (${report.newModels.length}):`)
  if (report.newModels.length === 0) console.log("   (none)")
  for (const finding of report.newModels) {
    const released = finding.releaseDate ? ` — released ${finding.releaseDate}` : ""
    console.log(`\n  + [${finding.terosProvider}] ${finding.id} (${finding.name})${released}`)
    if (finding.snippet) console.log(`${finding.snippet}`)
  }
  for (const [key, count] of Object.entries(report.meta.nonAgenticSkipped)) {
    console.log(
      `\n  ℹ️  ${key}: ${count} non-agentic upstream models ignored (no tools/context/text)`,
    )
  }
  for (const [key, count] of Object.entries(report.meta.omittedNew)) {
    console.log(
      `\n  ℹ️  ${key}: ${count} older upstream models omitted (use --all-new to list them)`,
    )
  }
}

function printDrift(report: Report): void {
  console.log(`\n📐 DRIFT on existing active models (${report.drift.length}):`)
  if (report.drift.length === 0) console.log("   (none)")
  for (const finding of report.drift) {
    console.log(`\n  ~ ${finding.modelId} [${finding.provider}] (${finding.modelString})`)
    for (const field of finding.fields) {
      const note = field.note ? `  [${field.note}]` : ""
      console.log(`      ${field.field}: ours=${field.ours} upstream=${field.upstream}${note}`)
    }
  }
}

function printRetired(report: Report): void {
  console.log(`\n🪦 RETIRED upstream — active in Teros (${report.retired.length}):`)
  if (report.retired.length === 0) console.log("   (none)")
  for (const finding of report.retired) {
    const label =
      finding.reason === "deprecated-upstream" ? "deprecated upstream" : "not listed upstream"
    console.log(`  - ${finding.modelId} [${finding.provider}] (${finding.modelString}): ${label}`)
    if (finding.note) console.log(`      ${finding.note}`)
  }
}

function printReport(report: Report): void {
  console.log("🔎 Model catalog check against upstream sources")
  console.log(
    `   models.dev ✓ · LiteLLM ${report.meta.sources.litellm ? "✓" : "✗ (skipped)"} · OpenRouter API ${report.meta.sources.openrouterApi ? "✓" : "✗ (skipped)"}`,
  )
  console.log(`   Providers checked: ${report.meta.providersChecked.join(", ")}`)
  if (report.meta.providersExcluded.length > 0) {
    console.log(`   Excluded: ${report.meta.providersExcluded.join(", ")}`)
  }

  printNewModels(report)
  printDrift(report)
  printRetired(report)

  if (report.skipped.length > 0) {
    console.log(`\n⏭️  Skipped models (${report.skipped.length}):`)
    for (const entry of report.skipped) {
      console.log(`  · ${entry.modelId} [${entry.provider}]: ${entry.reason}`)
    }
  }

  console.log(
    report.meta.hasFindings
      ? "\n⚠️  Findings above are advisory — catalog changes remain a human decision.\n"
      : "\n✅ Catalog is in sync with upstream sources.\n",
  )
}

// ============================================================================
// FETCHERS
// ============================================================================

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  return (await response.json()) as T
}

async function loadSources(): Promise<Sources> {
  const modelsDev = await fetchJson<ModelsDevData>(MODELS_DEV_URL)

  let litellm: Record<string, LiteLlmEntry> | null = null
  try {
    litellm = await fetchJson<Record<string, LiteLlmEntry>>(LITELLM_URL)
  } catch (error) {
    console.error(`⚠️  LiteLLM cross-check unavailable: ${(error as Error).message}`)
  }

  let openrouterApi: OpenRouterApiModel[] | null = null
  try {
    const payload = await fetchJson<{ data: OpenRouterApiModel[] }>(OPENROUTER_URL)
    openrouterApi = payload.data
  } catch (error) {
    console.error(
      `⚠️  OpenRouter API unavailable, falling back to models.dev: ${(error as Error).message}`,
    )
  }

  return { modelsDev, litellm, openrouterApi }
}

export function parseArgs(argv: string[]): CheckOptions {
  const opts: CheckOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") opts.json = true
    else if (arg === "--all-new") opts.allNew = true
    else if (arg === "--new-days") opts.newDays = Number(argv[++i])
    else if (arg === "--provider") opts.provider = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (opts.newDays !== undefined && (!Number.isFinite(opts.newDays) || opts.newDays <= 0)) {
    throw new Error("--new-days expects a positive number")
  }
  return opts
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const sources = await loadSources()
  const report = buildReport(MODEL_DEFINITIONS, sources, opts)
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
