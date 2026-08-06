/**
 * Elision of oversized tool-call arguments from the LLM-facing history
 * (TER-707 / CTX-016). Historical tool-call inputs that already executed are
 * pure overhead once past a size threshold: the model does not need to
 * re-read a `filesystem_write` body it already wrote, and re-sending it every
 * step/turn wastes context and can trip a provider's hard request limits
 * (Anthropic 32MB/413, OpenAI 1,048,576 chars/string/400).
 *
 * This module is a PURE projection: it never mutates its input, never drops
 * or reorders parts, and never touches anything except `state.input` values
 * that exceed the threshold. The result is copy-on-write — unaffected
 * messages/parts keep their original object identity — and MUST be used only
 * for the outbound LLM prompt window. NEVER persist a projected message back
 * to the session store (see `TurnDriver.loadProjectedMessages`, the sole
 * choke-point caller).
 *
 * Two fail-safe exemptions apply in the main history path only (NOT in the
 * summarizer path — see `projectToolInput` below):
 * - E1: parts in `error` state — the model needs its full args to
 *   self-correct a failed call.
 * - E2: parts carrying a Gemini `thoughtSignature` — Google's contract
 *   requires re-sending the signed part "exactly as returned"; mutating its
 *   args risks a permanent 400 (PLAN-398 v2 §1.7).
 */

import type { MessageWithParts, ToolPart, ToolState } from '../session/types';

/** Trigger per-part on JSON.stringify(state.input). Same threshold as the
 *  April hack / #398 draft. */
export const TOOL_ARG_EVICTION_THRESHOLD_CHARS = 20_000;
/** Head retained per elided string value (surrogate-safe cut). */
export const TOOL_ARG_VALUE_RETAIN_CHARS = 2_000;
/** Preview length for the fallback sentinel-object (head of the raw JSON). */
export const TOOL_ARG_PREVIEW_CHARS = 2_000;

/**
 * Cuts `str` at `maxLen` without splitting a UTF-16 surrogate pair. Local
 * copy of the TER-709 helper (that stack is not merged yet) — replace with
 * an import from `@teros/shared` once it lands. TODO(TER-709).
 */
export function splitAtCodePointBoundary(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  let end = maxLen;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    // Would split a high surrogate from its low surrogate — back off one.
    end -= 1;
  }
  return str.slice(0, end);
}

/**
 * Builds the marker appended after the retained head of an elided string
 * value. Self-descriptive (tells the model not to re-issue the call) AND
 * greppable (`[__terosElided:N]` suffix). `ELISION_MARKER_RE` is derived
 * from this SAME template — never hand-maintain the regex separately, or
 * idempotency (U7/U12/U13) breaks silently.
 */
export function buildElisionMarker(originalChars: number): string {
  return `…[system-elided ${originalChars} chars; call already executed — do not re-issue][__terosElided:${originalChars}]`;
}

/** Matches a marker produced by `buildElisionMarker` at the end of a string. */
export const ELISION_MARKER_RE =
  /…\[system-elided \d+ chars; call already executed — do not re-issue\]\[__terosElided:(\d+)\]$/;

/**
 * Fallback shape used ONLY when an input's mass is not in string values
 * (numeric arrays, thousands of short strings) or the input is not
 * serializable. Rare by construction — see `projectToolInput` step 6.
 */
export interface EvictedToolArgs {
  __terosEvicted: 'tool-args';
  /** -1 when the original input threw on JSON.stringify (cyclic/etc). */
  __originalChars: number;
  __note: string;
  __preview: string;
}

/**
 * Strict discriminant: exactly the 4 `EvictedToolArgs` keys, correct types,
 * and a capped `__preview` length. An impostor with an oversized `__preview`
 * fails the guard and therefore GETS projected — the safe failure direction.
 */
export function isEvictedToolArgs(input: unknown): input is EvictedToolArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).length !== 4) return false;
  if (obj.__terosEvicted !== 'tool-args') return false;
  if (typeof obj.__originalChars !== 'number') return false;
  if (typeof obj.__note !== 'string') return false;
  if (typeof obj.__preview !== 'string') return false;
  if (obj.__preview.length > TOOL_ARG_PREVIEW_CHARS * 2) return false;
  return true;
}

function buildSentinel(
  originalChars: number,
  preview: string,
  thresholdChars: number,
): EvictedToolArgs {
  return {
    __terosEvicted: 'tool-args',
    __originalChars: originalChars,
    __note:
      `Historical tool-call arguments over ${thresholdChars} chars were elided to save context. ` +
      `The call already executed with its full arguments — see its tool result for the outcome. ` +
      `Do not re-issue the call to "recover" them; if the content is needed, read it from the target system.`,
    __preview: preview,
  };
}

export type ToolArgEvictionMode = 'values' | 'fallback-sentinel' | 'non-serializable';

/** Outcome of projecting a single tool input, for the caller to log/aggregate. */
export interface ProjectedInput {
  input: unknown;
  eviction?: {
    originalChars: number;
    projectedChars: number;
    mode: ToolArgEvictionMode;
    valuesElided: number;
  };
}

interface ElideResult {
  value: unknown;
  changed: boolean;
  valuesElided: number;
}

/** Structural, shape-preserving walk: elides only oversized string VALUES,
 *  at any depth, copy-on-write along modified paths only. */
function elideValue(value: unknown, retainChars: number): ElideResult {
  if (typeof value === 'string') {
    const match = value.match(ELISION_MARKER_RE);
    if (match && value.length <= retainChars + match[0].length) {
      // Already in elided form from a prior pass — leave it (idempotency).
      return { value, changed: false, valuesElided: 0 };
    }
    const marker = buildElisionMarker(value.length);
    if (value.length > retainChars + marker.length) {
      const head = splitAtCodePointBoundary(value, retainChars);
      return { value: head + marker, changed: true, valuesElided: 1 };
    }
    return { value, changed: false, valuesElided: 0 };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let valuesElided = 0;
    const next = value.map((item) => {
      const r = elideValue(item, retainChars);
      if (r.changed) {
        changed = true;
        valuesElided += r.valuesElided;
        return r.value;
      }
      return item;
    });
    return changed
      ? { value: next, changed: true, valuesElided }
      : { value, changed: false, valuesElided: 0 };
  }

  if (value && typeof value === 'object') {
    let changed = false;
    let valuesElided = 0;
    const next: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const r = elideValue(v, retainChars);
      next[key] = r.changed ? r.value : v;
      if (r.changed) {
        changed = true;
        valuesElided += r.valuesElided;
      }
    }
    return changed
      ? { value: next, changed: true, valuesElided }
      : { value, changed: false, valuesElided: 0 };
  }

  return { value, changed: false, valuesElided: 0 };
}

/**
 * Core per-value projection — NO status/thoughtSignature exemptions. Two
 * call sites share this ONE implementation on purpose (review-2 N3/F5):
 * - `evictOversizedToolArgs` below, for parts that are NOT E1/E2-exempt.
 * - the compaction summarizer (`compaction/index.ts` `formatMessagesForSummary`),
 *   which must bound EVERY tool input it stringifies — including error/signed
 *   parts, because neither the auto-correction nor the thoughtSignature
 *   round-trip contract apply to the one-shot summarization prompt. Calling
 *   the exemption-honoring `evictOversizedToolArgs` there would leave those
 *   parts unbound and not fix the summarizer overflow at all.
 *
 * Pure, synchronous, no I/O. Never throws — a non-serializable input is
 * "evict for safety", not an error (the adapters would throw on it too).
 */
export function projectToolInput(
  input: unknown,
  opts?: { thresholdChars?: number; retainChars?: number },
): ProjectedInput {
  const thresholdChars = opts?.thresholdChars ?? TOOL_ARG_EVICTION_THRESHOLD_CHARS;
  const retainChars = opts?.retainChars ?? TOOL_ARG_VALUE_RETAIN_CHARS;

  // Idempotency short-circuit — independent of thresholdChars, so a retuned
  // constant never re-processes an already-evicted sentinel.
  if (isEvictedToolArgs(input)) {
    return { input };
  }

  let raw: string;
  try {
    raw = JSON.stringify(input ?? {});
  } catch {
    const sentinel = buildSentinel(-1, '', thresholdChars);
    return {
      input: sentinel,
      eviction: {
        originalChars: -1,
        projectedChars: JSON.stringify(sentinel).length,
        mode: 'non-serializable',
        valuesElided: 0,
      },
    };
  }

  if (raw.length <= thresholdChars) {
    return { input };
  }

  const elided = elideValue(input, retainChars);
  const elidedRaw = JSON.stringify(elided.value);

  if (elidedRaw.length > thresholdChars) {
    // Mass wasn't in string values (or elision alone didn't get under the
    // threshold) — fall back to the sentinel-object. Rare by construction;
    // the only case where the input's keys are lost. Logged distinctly
    // (mode: 'fallback-sentinel') so it can be watched in prod.
    const preview = splitAtCodePointBoundary(raw, TOOL_ARG_PREVIEW_CHARS);
    const sentinel = buildSentinel(raw.length, preview, thresholdChars);
    return {
      input: sentinel,
      eviction: {
        originalChars: raw.length,
        projectedChars: JSON.stringify(sentinel).length,
        mode: 'fallback-sentinel',
        valuesElided: elided.valuesElided,
      },
    };
  }

  return {
    input: elided.value,
    eviction: {
      originalChars: raw.length,
      projectedChars: elidedRaw.length,
      mode: 'values',
      valuesElided: elided.valuesElided,
    },
  };
}

/** One part's eviction, reported to the caller for structured logging. */
export interface ToolArgEviction {
  messageId: string;
  callID: string;
  tool: string;
  originalChars: number;
  projectedChars: number;
  mode: ToolArgEvictionMode;
  valuesElided: number;
}

function withInput(part: ToolPart, newInput: unknown): ToolPart {
  return { ...part, state: { ...part.state, input: newInput } as ToolState };
}

/**
 * E1 (error state — auto-correction) + E2 (Gemini thoughtSignature —
 * round-trip contract). Shared by `evictOversizedToolArgs` and
 * `assertToolArgsProjected` so the two exemption checks never drift apart.
 */
function isExemptToolPart(part: ToolPart): boolean {
  return part.state.status === 'error' || Boolean(part.metadata?.thoughtSignature);
}

/**
 * Projects a whole LLM-facing message window: elides oversized tool-call
 * inputs, exempting E1 (`error` state — auto-correction) and E2 (Gemini
 * `thoughtSignature` — round-trip contract). Copy-on-write at every level: a
 * message with no evicted part keeps its original reference; a part that is
 * untouched (exempt, already under threshold, or already-elided) keeps its
 * reference too.
 *
 * ⚠️ The output is for the outbound LLM prompt ONLY — never persist it back
 * to the session store.
 */
export function evictOversizedToolArgs(
  messages: MessageWithParts[],
  opts?: { thresholdChars?: number; retainChars?: number },
): { messages: MessageWithParts[]; evictions: ToolArgEviction[] } {
  const evictions: ToolArgEviction[] = [];

  const projected = messages.map((msg) => {
    let messageChanged = false;
    const parts = msg.parts.map((part) => {
      if (part.type !== 'tool') return part;

      // E1/E2 — preserve full args for error auto-correction and for
      // Gemini's "return the signed part exactly as returned" contract.
      if (isExemptToolPart(part)) return part;

      const input = (part.state as { input?: unknown }).input;
      if (input === undefined) return part;

      const result = projectToolInput(input, opts);
      if (!result.eviction) return part;

      messageChanged = true;
      evictions.push({
        messageId: msg.info.id,
        callID: part.callID,
        tool: part.tool,
        ...result.eviction,
      });
      return withInput(part, result.input);
    });

    return messageChanged ? { ...msg, parts } : msg;
  });

  return { messages: projected, evictions };
}

/**
 * Defense-in-depth structural check at the prompt edge (called from
 * `TurnDriver.composePrompt`, right before `buildPrompt`): throws if any
 * NON-exempt tool part's input still exceeds the threshold at the point
 * where the prompt is about to be sent to the adapters.
 *
 * G1 (the source-scan guard) is file-level — it can't see whether a call
 * site *inside* an allowlisted file actually ran the projection (review-2
 * F2). This closes that gap at runtime. A violation here means a message
 * window reached the prompt without going through
 * `TurnDriver.loadProjectedMessages` — a regression, never a normal runtime
 * condition — so it fails loud instead of silently re-introducing CTX-016.
 *
 * Cheap: bails on the first violation, and skips entirely when the
 * kill-switch is off (the caller is responsible for that check, since only
 * it knows `deps.toolArgEviction`).
 */
export function assertToolArgsProjected(
  messages: MessageWithParts[],
  thresholdChars: number = TOOL_ARG_EVICTION_THRESHOLD_CHARS,
): void {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue;
      if (isExemptToolPart(part)) continue;

      const input = (part.state as { input?: unknown }).input;
      if (input === undefined || isEvictedToolArgs(input)) continue;

      let raw: string;
      try {
        raw = JSON.stringify(input);
      } catch {
        // Non-serializable is projectToolInput's problem (mode:
        // 'non-serializable'), not this assert's — it can't measure it
        // either, and the adapters would throw on it regardless.
        continue;
      }

      if (raw.length > thresholdChars) {
        throw new Error(
          `[tool-arg-eviction] Unprojected oversized tool-call input reached the prompt edge ` +
            `(tool=${part.tool}, callID=${part.callID}, chars=${raw.length} > ${thresholdChars}). ` +
            `A message window bypassed TurnDriver.loadProjectedMessages — see ` +
            `packages/core/src/prompts/tool-arg-eviction.ts.`,
        );
      }
    }
  }
}
