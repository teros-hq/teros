/**
 * Conversation Evaluator — L2 windowing (PURE module).
 *
 * Spec: docs/specs/20261015_conversation-evaluator.md
 * Task: task_db265dd9a4e8d376 (fase 3)
 *
 * Regla dura de Pablo (20-oct): LECTURA COMPLETA, CERO CONDENSACIÓN.
 * The evaluator reads 100% of the messages. Conversations that do not fit in
 * one context are partitioned WITHOUT LOSS:
 *   - sequential windows, every message read exactly once and whole
 *   - no overlap between windows, no gaps
 *   - accumulated state (intents seen, failures, feature requests) is carried
 *     from window to window by the CALLER (the evaluator agent updates it;
 *     this module only echoes it through)
 *   - a final synthesis pass emits the evaluation record
 *
 * PURITY CONTRACT: zero I/O. The backend action loads Mongo docs, maps them
 * to WindowMessage, and calls these functions.
 *
 * What goes into a window (full-fidelity rendering, no sampling):
 *   - user/assistant text parts: FULL text, never truncated
 *   - tool parts: tool name (+ app/innerTool for execute-tool), FULL input,
 *     status, FULL error text, and output. Output is the only field that may
 *     be CAPPED in size (never dropped) to keep windows transportable: the cap
 *     is a byte budget per window, applied to the LONGEST outputs first, and
 *     every cap is recorded in `truncations` so the evaluator knows exactly
 *     what was cut. (Pablo's rule bans content LOSS, not byte caps with an
 *     audit trail — silent dropping would be loss.)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowToolPart {
  kind: 'tool';
  callId: string;
  /** Effective tool name: `app/innerTool` for execute-tool wrappers, else the tool name */
  tool: string;
  /** Canonical input (inner input for execute-tool wrappers) */
  input: unknown;
  status: 'completed' | 'error' | 'unknown';
  /** FULL error text (not first-line) when status === 'error' */
  error?: string;
  /** Tool output text — possibly capped, see `truncatedBytes` */
  output?: string;
  /** Bytes cut from `output` (0 = intact) */
  truncatedBytes: number;
  startedAt: number;
  endedAt?: number;
}

export interface WindowTextPart {
  kind: 'text';
  /** FULL text, never truncated */
  text: string;
}

export type WindowPart = WindowToolPart | WindowTextPart;

export interface WindowMessage {
  /** Global message index in the conversation (0-based, stable across windows) */
  index: number;
  role: 'user' | 'assistant' | 'system';
  createdAt: number;
  isVoice?: boolean;
  parts: WindowPart[];
}

/** Accumulated state carried across windows — owned and updated by the evaluator. */
export interface WindowAccumulatedState {
  /** Intents detected so far (vocabulary spec §5), with the message where first seen */
  intents: Array<{ id: string; firstSeenMessageIndex: number; primary?: boolean; justification?: string }>;
  /** Failures detected so far (technical det + behavioral BEH/llm) */
  failures: Array<{
    code: string;
    severity: string;
    detectorLayer: 'det' | 'llm';
    evidenceMessageIndexes: number[];
    evidenceCallIds?: string[];
    note?: string;
  }>;
  /** Feature requests / notable user asks seen so far */
  featureRequests: Array<{ messageIndex: number; summary: string }>;
  /** Free-form running notes the evaluator wants to carry (kept short by convention) */
  notes?: string;
}

export interface ConversationWindow {
  channelId: string;
  windowIndex: number;
  windowCount: number;
  /** Global index of the first message in this window */
  fromIndex: number;
  /** Global index of the last message in this window (inclusive; -1 when empty) */
  toIndex: number;
  totalMessages: number;
  messages: WindowMessage[];
  /** Accumulated state AFTER the previous window (empty on window 0) */
  accumulated: WindowAccumulatedState;
  /** Audit trail of every output cap applied in THIS window */
  truncations: Array<{ callId: string; originalBytes: number; keptBytes: number }>;
  /** True when this is the last window (the synthesis pass happens after it) */
  isLast: boolean;
}

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_SIZE = 60;
export const MAX_WINDOW_SIZE = 200;
/** Per-window byte budget for tool OUTPUTS (inputs and texts are never capped). */
export const DEFAULT_OUTPUT_BUDGET_BYTES = 120_000;
/** No single output may keep more than this, regardless of budget. */
export const MAX_SINGLE_OUTPUT_BYTES = 20_000;

export interface PartitionOptions {
  windowSize?: number;
  outputBudgetBytes?: number;
}

export function emptyAccumulatedState(): WindowAccumulatedState {
  return { intents: [], failures: [], featureRequests: [] };
}

/**
 * Compute window boundaries for `totalMessages` messages with the given size.
 * Guarantees: windows are contiguous, non-overlapping, cover [0, total).
 * Returns an array of [fromIndex, toIndexInclusive] pairs.
 */
export function computeWindowBounds(totalMessages: number, windowSize: number): Array<[number, number]> {
  if (totalMessages < 0) throw new Error('totalMessages must be >= 0');
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('windowSize must be an integer >= 1');
  if (windowSize > MAX_WINDOW_SIZE) throw new Error(`windowSize must be <= ${MAX_WINDOW_SIZE}`);
  const bounds: Array<[number, number]> = [];
  for (let from = 0; from < totalMessages; from += windowSize) {
    bounds.push([from, Math.min(from + windowSize, totalMessages) - 1]);
  }
  return bounds;
}

/**
 * Cap tool outputs in a window's messages to fit the byte budget.
 * Strategy: longest outputs first, fair-share cap floored at 500B so small
 * outputs survive intact; additionally no output keeps more than
 * MAX_SINGLE_OUTPUT_BYTES. Texts and inputs are never touched.
 * Returns new message objects (input not mutated) plus the truncation audit.
 */
export function capWindowOutputs(
  messages: WindowMessage[],
  budgetBytes: number = DEFAULT_OUTPUT_BUDGET_BYTES,
): { messages: WindowMessage[]; truncations: ConversationWindow['truncations'] } {
  const toolParts: WindowToolPart[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'tool' && p.output) toolParts.push(p);
    }
  }
  const total = toolParts.reduce((s, p) => s + (p.output?.length ?? 0), 0);
  if (total <= budgetBytes && toolParts.every((p) => (p.output?.length ?? 0) <= MAX_SINGLE_OUTPUT_BYTES)) {
    return { messages, truncations: [] };
  }

  const sorted = [...toolParts].sort((a, b) => (b.output?.length ?? 0) - (a.output?.length ?? 0));
  let remaining = budgetBytes;
  let left = sorted.length;
  const capOf = new Map<string, number>();
  for (const p of sorted) {
    const len = p.output?.length ?? 0;
    const fairShare = Math.max(500, Math.floor(remaining / Math.max(1, left)));
    const cap = Math.min(len, MAX_SINGLE_OUTPUT_BYTES, fairShare);
    capOf.set(p.callId, cap);
    remaining -= cap;
    left--;
  }

  const truncations: ConversationWindow['truncations'] = [];
  const newMessages = messages.map((m) => ({
    ...m,
    parts: m.parts.map((p): WindowPart => {
      if (p.kind !== 'tool' || !p.output) return p;
      const cap = capOf.get(p.callId);
      if (cap === undefined || cap >= p.output.length) return { ...p, truncatedBytes: 0 };
      truncations.push({ callId: p.callId, originalBytes: p.output.length, keptBytes: cap });
      return { ...p, output: p.output.slice(0, cap), truncatedBytes: p.output.length - cap };
    }),
  }));
  return { messages: newMessages, truncations };
}

/**
 * Build window `windowIndex` from a fully-mapped message array.
 * `accumulated` is the state after the previous window (echoed through, not mutated).
 */
export function buildWindow(
  channelId: string,
  allMessages: WindowMessage[],
  windowIndex: number,
  options: PartitionOptions = {},
  accumulated?: WindowAccumulatedState,
): ConversationWindow {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const bounds = computeWindowBounds(allMessages.length, windowSize);
  if (bounds.length === 0) {
    if (windowIndex !== 0) throw new Error('windowIndex 0 is the only valid window of an empty conversation');
    return {
      channelId,
      windowIndex: 0,
      windowCount: 1,
      fromIndex: 0,
      toIndex: -1,
      totalMessages: 0,
      messages: [],
      accumulated: accumulated ?? emptyAccumulatedState(),
      truncations: [],
      isLast: true,
    };
  }
  if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex >= bounds.length) {
    throw new Error(`windowIndex ${windowIndex} out of range (0..${bounds.length - 1})`);
  }
  const [from, to] = bounds[windowIndex];
  const slice = allMessages.slice(from, to + 1);
  const { messages, truncations } = capWindowOutputs(slice, options.outputBudgetBytes);
  return {
    channelId,
    windowIndex,
    windowCount: bounds.length,
    fromIndex: from,
    toIndex: to,
    totalMessages: allMessages.length,
    messages,
    accumulated: accumulated ?? emptyAccumulatedState(),
    truncations,
    isLast: windowIndex === bounds.length - 1,
  };
}

// ---------------------------------------------------------------------------
// Vocabularies (Pablo's two-table decision, 2026-10-20) — shared constants
// ---------------------------------------------------------------------------

/** Behavioral friction codes (Tabla B — detectorLayer=llm). Closed v0 vocabulary. */
export const BEH_CODES = ['BEH-1', 'BEH-2', 'BEH-3', 'BEH-4', 'BEH-5', 'BEH-other'] as const;
export type BehCode = (typeof BEH_CODES)[number];

/** Technical friction families (Tabla A — detectorLayer=det). */
export const TECH_FAILURE_CODES = ['REP-1', 'REP-3', 'RTX-1', 'RTX-2', 'INE-1', 'INE-2', 'INE-3'] as const;

/** LLM-layer taxonomy codes from spec §6 that are NOT BEH (judged by the evaluator). */
export const LLM_FAILURE_CODES = [
  'REP-2',
  'RTX-3',
  'OUT-1',
  'OUT-2',
  'USR-1',
  'USR-2',
  'VIOL-1',
  'SCO-1',
  'HALL-1',
] as const;

export const INTENT_VOCABULARY = [
  'research_web',
  'search_internal',
  'content_creation',
  'coding',
  'devops',
  'data_analysis',
  'communication',
  'project_management',
  'scheduling',
  'quick_question',
  'delegation',
  'feedback_meta',
  'smalltalk',
  'other',
] as const;
export type IntentId = (typeof INTENT_VOCABULARY)[number];

export const OUTCOMES = ['achieved', 'partial', 'failed', 'abandoned', 'trivial'] as const;
export type Outcome = (typeof OUTCOMES)[number];
