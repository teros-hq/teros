/**
 * Intent-line resolution for the permission-approval card.
 *
 * Five layers, highest precedence first:
 *   1. override    — the MCA's own `*-permission-description.ts` (TER-281)
 *   2. template    — `annotations.intentTemplate`, app-declared, interpolated
 *   3. summary     — `annotations.summary`, author-curated human copy (TER-538)
 *   4. description — the tool's `tools.json` description (technical but specific)
 *   5. label       — the caller's static label (mechanical)
 *
 * Layers 2–4 are declared by the app; layer 1 is compiled into this frontend and
 * therefore only reachable for MCAs shipped in this repo. That is why layer 2
 * exists: an app authored elsewhere can still say what its tool will do.
 *
 * This IS a fallback chain, which engineering principle 2 otherwise forbids, so it
 * is built to be observable instead of silent: resolution is a sequence of named
 * steps (never `a || b || c`) and the winning layer is reported in `source`. A
 * spike in `source === "label"` is a coverage gap, not a hidden substitution.
 *
 * All layers return PLAIN TEXT. Never render this through
 * `dangerouslySetInnerHTML` — the deleted PermissionRequestWidget did, and its
 * HTML-string descriptions died with it.
 *
 * Pure by design: no React, no react-native, so `bun test` can exercise it.
 */

import {
  type BashPermissionInput,
  getBashPermissionDescription,
} from "../renderers/bash-permission-description"
import {
  type FilesystemPermissionInput,
  getFilesystemPermissionDescription,
} from "../renderers/filesystem-permission-description"
import {
  getNetlifyPermissionDescription,
  type NetlifyPermissionInput,
} from "../renderers/netlify-permission-description"
import { sliceWholeChars } from "./param-relevance"

export type IntentSource = "override" | "template" | "summary" | "description" | "label"

export interface ResolvedIntent {
  text: string
  source: IntentSource
}

export interface ResolveIntentArgs {
  /** Namespaced tool name as it arrives from the backend, e.g. `mydrive_share-file`. */
  toolName: string
  mcaId?: string
  input?: Record<string, unknown>
  detail?: {
    description: string
    annotations?: { summary?: string; intentTemplate?: string }
  }
  /** Layer 5 — the caller's static label. Required. */
  fallbackText: string
  /**
   * Reports a layer-1 override that threw. Injected rather than importing
   * `lib/sentry` here, for the same reason the module imports no React: it must
   * stay parseable by `bun test`. Omitting it means the throw is neither
   * reported nor propagated, so callers rendering in a tree without an error
   * boundary should always pass one.
   */
  onOverrideError?: (error: unknown, context: { mcaId: string; toolName: string }) => void
}

type OverrideFn = (shortName: string, input?: Record<string, unknown>) => string | null

/**
 * `input` is raw LLM-generated tool arguments: the MCA validates them AFTER
 * approval, so at this point nothing has checked that `command` is a string or
 * that `path` is not an array. The override bodies assume strings, so every
 * field an override reads is narrowed here and the override is skipped when the
 * shape is wrong. A wrong-typed argument is precisely the case a permission gate
 * exists to catch; it must not be the case that takes the gate down.
 */
function stringField(input: Record<string, unknown> | undefined, key: string): boolean {
  return typeof input?.[key] === "string"
}

/** Bash reads only `command` (plus optional string `cwd`/`description`). */
function bashInputUsable(input: Record<string, unknown> | undefined): boolean {
  if (!stringField(input, "command")) return false
  for (const key of ["cwd", "description"]) {
    if (input?.[key] !== undefined && !stringField(input, key)) return false
  }
  return true
}

/**
 * Every field the override interpolates must be a string when present. Absent is
 * fine — the override modules all handle `undefined` and say so in their copy.
 * A wrong-typed value would either throw (filesystem calls `.startsWith`) or
 * interpolate as `[object Object]` into the sentence the reviewer is trusting.
 */
function stringFieldsUsable(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean {
  if (input === undefined) return true
  for (const key of keys) {
    if (input[key] !== undefined && !stringField(input, key)) return false
  }
  return true
}

const FILESYSTEM_STRING_FIELDS = [
  "path",
  "filePath",
  "source",
  "destination",
  "pattern",
  "algorithm",
] as const

const NETLIFY_STRING_FIELDS = ["dir", "siteId", "siteName", "deployId"] as const

function filesystemInputUsable(input: Record<string, unknown> | undefined): boolean {
  if (!stringFieldsUsable(input, FILESYSTEM_STRING_FIELDS)) return false
  return input?.paths === undefined || Array.isArray(input.paths)
}

/**
 * Normalises the three existing override signatures behind one shape. Bash keys
 * only on input; filesystem and netlify take the short tool name as well. Each
 * entry declines (returns null) when the input shape it needs is not present,
 * which lets resolution fall through to layer 2/3/4 instead of throwing.
 */
const OVERRIDES: Record<string, OverrideFn> = {
  "mca.teros.bash": (_shortName, input) =>
    bashInputUsable(input)
      ? getBashPermissionDescription(input as BashPermissionInput | undefined)
      : null,
  "mca.teros.filesystem": (shortName, input) =>
    filesystemInputUsable(input)
      ? getFilesystemPermissionDescription(
          shortName,
          input as FilesystemPermissionInput | undefined,
        )
      : null,
  "mca.netlify": (shortName, input) =>
    stringFieldsUsable(input, NETLIFY_STRING_FIELDS)
      ? getNetlifyPermissionDescription(shortName, input as NetlifyPermissionInput | undefined)
      : null,
}

/** Bare tool name: `mydrive_share-file` → `share-file`. Mirrors getShortToolName. */
function shortToolName(toolName: string): string {
  const parts = toolName.split("_")
  return parts[parts.length - 1] || toolName
}

/**
 * Runs layer 1 without letting it escape. Narrowing above already declines the
 * wrong-typed shapes we know the overrides read, but this resolver runs during
 * render with no error boundary between it and the chat root, so a throw from
 * any future override would blank the conversation and leave the user unable to
 * approve OR deny. The error is reported, never swallowed silently.
 */
function tryOverride(
  override: OverrideFn,
  mcaId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
  onError: ResolveIntentArgs["onOverrideError"],
): string | null {
  try {
    return nonBlank(override(shortToolName(toolName), input))
  } catch (error) {
    onError?.(error, { mcaId, toolName })
    return null
  }
}

function nonBlank(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Longest rendered intent line's character length. Clips runaway values — the
 * card's `Text` does not set `numberOfLines`, so this bounds the string, not the
 * number of visual lines a long-but-under-cap value may still wrap across.
 */
export const INTENT_TEMPLATE_MAX_CHARS = 200

/**
 * Floor on the per-value budget, so a template whose own text nearly fills the
 * cap still shows enough of each argument to identify it, rather than clipping
 * every value to nothing.
 */
export const INTENT_VALUE_MIN_CHARS = 24

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

/**
 * A brace left over once every well-formed placeholder is removed.
 *
 * The template grammar is `{` + `[A-Za-z0-9_]+` + `}` and nothing else, so a
 * hyphenated or dotted parameter name — `{file-id}`, `{page.size}`, both legal
 * JSON Schema property names and kebab-case being common in this ecosystem — is
 * not a placeholder. Before, those fell through the `replace` untouched and
 * `"Share {file-id} with {email}"` reached the approval sentence as
 * `"Share {file-id} with a@b.c"`: neither interpolated nor declined, which is
 * exactly what the protocol's MUST (decline when a referenced parameter is
 * absent) forbids, and a parameter that can never be referenced is absent by
 * construction.
 *
 * Tested against the TEMPLATE with valid placeholders stripped, never against the
 * assembled line: a brace arriving inside a model-generated ARGUMENT is that
 * argument's own content and must not retroactively decline the author's words.
 */
const RESIDUAL_BRACE = /[{}]/

/**
 * True when the template carries a brace the grammar cannot resolve. False for a
 * template that legitimately has no placeholders at all ("Lists your calendars"),
 * which must still render.
 */
function hasUnresolvableBrace(template: string): boolean {
  return RESIDUAL_BRACE.test(template.replace(PLACEHOLDER, ""))
}

/**
 * Characters each interpolated value may occupy: the cap minus the author's own
 * literal text, split evenly across the placeholders and floored at
 * `INTENT_VALUE_MIN_CHARS`.
 *
 * The value is clipped rather than the assembled sentence because the arguments
 * are model-chosen and the template's words are not: clipping the sentence lets a
 * 190-character `path` push the author's consequence clause out of view, so
 * `"Delete {path} from production"` renders as `"Delete xxxx…"` and the reviewer
 * approves without ever seeing which environment it names. The author's text
 * always survives; the argument is what gets elided.
 *
 * The literal length is measured on the RAW template (no whitespace collapse), so
 * it can only over-count — the budget is conservative and the assembled line stays
 * within the cap.
 */
function valueBudget(template: string, placeholders: number): number {
  const literalChars = template.replace(PLACEHOLDER, "").length
  const share = Math.floor((INTENT_TEMPLATE_MAX_CHARS - literalChars) / placeholders)
  return Math.max(INTENT_VALUE_MIN_CHARS, share)
}

/** Bounds one interpolated value without ever splitting a surrogate pair. */
function clipValue(value: string, budget: number): string {
  if (value.length <= budget) return value
  return `${sliceWholeChars(value, budget - 1)}…`
}

/**
 * Fills `{param}` placeholders from the call's arguments.
 *
 * Declines (returns null) rather than degrading, for the same reason the layer-1
 * narrowing does: `input` is raw model-generated arguments that the MCA only
 * validates AFTER approval, so a placeholder may name a param that is absent or
 * that arrived as an object. Interpolating those produces "Delete the file at
 * undefined" or "[object Object]" inside the one sentence the reviewer is
 * trusting. A declined template falls through to `summary`/`description`, which
 * are at least true. The same reasoning declines a blank/whitespace-only string
 * and a non-finite number (`NaN`/`Infinity`) — "Delete the file at" and "Fetch
 * NaN items" degrade the sentence exactly as an absent param would.
 *
 * Newlines collapse to spaces: the intent line is meant to read as one
 * sentence, and a multi-line value would either be clipped mid-sentence or push
 * the card's layout, both of which hide information at the moment of decision.
 *
 * Also declines when the template carries a brace outside a well-formed
 * `{param}` placeholder — a hyphenated or dotted parameter name, an empty `{}`,
 * a stray `{`. `{` is reserved by the grammar, so there is no legitimate literal
 * brace to preserve, and the alternative is raw braces in the approval sentence.
 * A placeholder-free template still renders untouched.
 *
 * Over-long values are clipped per value (`valueBudget`), so the author's own
 * words always survive. The assembled line is still bounded as a last resort —
 * that only bites when the template's own text exceeds the cap, which is the
 * author's text, not an argument's.
 */
export function renderIntentTemplate(
  template: string,
  input: Record<string, unknown> | undefined,
): string | null {
  // Checked before interpolation, so an unreferenceable `{file-id}` declines the
  // template rather than leaking literal braces into the one sentence the
  // reviewer is trusting. See `RESIDUAL_BRACE`.
  if (hasUnresolvableBrace(template)) return null

  let declined = false

  const placeholders = template.match(PLACEHOLDER)?.length ?? 0
  const budget = placeholders > 0 ? valueBudget(template, placeholders) : INTENT_TEMPLATE_MAX_CHARS

  const filled = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = input?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return clipValue(value, budget)
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value)
    }
    if (typeof value === "boolean") {
      return String(value)
    }
    declined = true
    return ""
  })

  if (declined) return null

  // Whitespace collapses first so a literal \n/\t (Unicode category Cc, same as
  // the control characters below) becomes a separating space rather than being
  // deleted outright and fusing the words on either side of it.
  const spaced = filled.replace(/\s+/g, " ").trim()

  // Model-generated values can carry bidi overrides (U+202E etc.), zero-width
  // characters, or other control/format code points — invisible or
  // rendering-altering bytes that would let an argument rewrite how the rest of
  // the sentence *looks* to the human deciding whether to approve it (e.g. an
  // RLO turning "safe.txt‮gpj.exe" into what reads as "safe.txtexe.jpg"). These
  // are category Cf (format), distinct from the Cc handled by the collapse
  // above, so stripping them here cannot re-fuse words the collapse separated.
  const collapsed = spaced.replace(/[\p{Cc}\p{Cf}]/gu, "")
  if (collapsed.length === 0) return null
  if (collapsed.length <= INTENT_TEMPLATE_MAX_CHARS) return collapsed
  return `${sliceWholeChars(collapsed, INTENT_TEMPLATE_MAX_CHARS - 1)}…`
}

export function resolveIntent(args: ResolveIntentArgs): ResolvedIntent {
  const { toolName, mcaId, input, detail, fallbackText, onOverrideError } = args

  if (!toolName) {
    throw new Error("resolveIntent: toolName is required")
  }
  if (typeof fallbackText !== "string") {
    throw new Error(`resolveIntent: fallbackText is required (toolName=${toolName})`)
  }

  // Layer 1 — per-MCA override.
  if (mcaId) {
    const override = OVERRIDES[mcaId]
    if (override) {
      const text = tryOverride(override, mcaId, toolName, input, onOverrideError)
      if (text) return { text, source: "override" }
    }
  }

  // Layer 2 — app-declared template, interpolated from this call's arguments.
  const template = nonBlank(detail?.annotations?.intentTemplate)
  if (template) {
    const rendered = renderIntentTemplate(template, input)
    if (rendered) return { text: rendered, source: "template" }
  }

  // Layer 3 — curated human summary.
  const summary = nonBlank(detail?.annotations?.summary)
  if (summary) return { text: summary, source: "summary" }

  // Layer 4 — the tool's own description.
  const description = nonBlank(detail?.description)
  if (description) return { text: description, source: "description" }

  // Layer 5 — mechanical static label supplied by the caller.
  return { text: fallbackText, source: "label" }
}
