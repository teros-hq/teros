/**
 * Conversation Evaluator — Layer 1 deterministic extractor (PURE module).
 *
 * Spec: docs/specs/20261015_conversation-evaluator.md (§3 Layer 1, §6 taxonomy)
 * Protocol: docs/specs/20261015_annotation-protocol.md (§4 decision rules)
 *
 * PURITY CONTRACT: this module does ZERO I/O. No Mongo, no fs, no network.
 * Input = plain in-memory session data (already loaded by the caller).
 * Output = plain JSON metrics + detected failures per conversation.
 *
 * Placement decision (2026-10-20, Nira): lives in @teros/shared so the future
 * backend action `packages/backend/src/mca-actions/evaluator.ts` can import it
 * directly (backend already depends on @teros/shared), and the backfill script
 * (scripts/eval/) can import it too. scripts/eval/lib was rejected because the
 * backend must not import from scripts/.
 *
 * Detectors (deterministic, taxonomy v0.1 decision rules):
 *   REP-1  >=3 consecutive identical tool calls (same tool + byte-identical input),
 *          no user message in between
 *   REP-3  same substantive assistant text sent to the user >=2 times
 *   RTX-1  retry after error with same tool + same input >=1 time
 *   RTX-2  blind schema guessing: error -> params changed -> error, without
 *          consulting list-app-tools in between
 *   INE-1  exhaustive pagination >=10 consecutive page/next calls when a
 *          search/filter param exists on the same tool
 *   INE-2  probing shotgun >=8 one-by-one calls when a bulk/filter alternative exists
 *   INE-3  redundant calls (same tool+input already succeeded) / re-discovering schema
 *
 * Metrics: message counts (user/assistant/voice), tool calls by status, error rate,
 * unique-call ratio, stopReason stats, steps, duration, cost and tokens.
 */

// ---------------------------------------------------------------------------
// Input types (plain JSON — the caller maps Mongo docs into these)
// ---------------------------------------------------------------------------

export interface EvalToolCall {
  /** Stable id of the tool call part (callID) */
  callId: string;
  /** Tool name as invoked (e.g. 'execute-tool', 'list-app-tools') */
  tool: string;
  /** For execute-tool wrappers: the inner app name, else undefined */
  app?: string;
  /** For execute-tool wrappers: the inner tool name, else undefined */
  innerTool?: string;
  /** Canonical input object (for execute-tool: the inner `input`) */
  input: unknown;
  /** Byte-stable serialization of the canonical input (JSON.stringify with sorted keys) */
  inputKey: string;
  status: 'completed' | 'error' | 'unknown';
  /** Error message first line when status === 'error' */
  errorFirstLine?: string;
  /** Epoch ms when the call started */
  startedAt: number;
  /** Epoch ms when the call ended (undefined if unknown) */
  endedAt?: number;
}

export interface EvalMessage {
  role: 'user' | 'assistant' | 'system';
  /** Epoch ms */
  createdAt: number;
  /** Concatenated text parts (assistant/user). Empty string if none. */
  text: string;
  /** True when the user-facing message was a voice message (channel_messages.content.type === 'voice') */
  isVoice?: boolean;
  /** Tool calls contained in this message, in order */
  toolCalls: EvalToolCall[];
}

export interface EvalLlmUsageRow {
  modelId: string;
  provider?: string;
  /** Present only on turn-serving rows (spec §2 single-model rule) */
  messageId?: string;
  timestamp: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costTotal?: number;
  latencyMs?: number;
  stopReason?: string;
}

export interface EvalInput {
  channelId: string;
  /** Ordered session messages (session_messages consolidated by info.id, sorted by created) */
  messages: EvalMessage[];
  /** llm_usage rows for the channel */
  llmUsage: EvalLlmUsageRow[];
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type FailureCode = 'REP-1' | 'REP-3' | 'RTX-1' | 'RTX-2' | 'INE-1' | 'INE-2' | 'INE-3';

export interface Failure {
  code: FailureCode;
  severity: 'critical' | 'high' | 'medium';
  detector: 'det';
  /** Human-auditable evidence: tool call ids / message indexes involved */
  evidence: {
    callIds?: string[];
    messageIndexes?: number[];
    tool?: string;
    detail?: string;
  };
}

export interface ConversationMetrics {
  channelId: string;
  // messages
  userMessages: number;
  assistantMessages: number;
  voiceMessages: number;
  // tool calls
  toolCallsTotal: number;
  toolCallsCompleted: number;
  toolCallsError: number;
  toolErrorRate: number; // 0..1
  uniqueCallRatio: number; // distinct (tool+inputKey) / total
  // stopReason stats (from llm_usage rows with a stopReason)
  stopReasons: Record<string, number>;
  // steps = number of llm_usage rows with a messageId (turn-serving LLM calls)
  steps: number;
  // duration of the conversation activity window (first..last llm_usage ts; fallback: message bounds)
  durationMs: number;
  // cost & tokens (sum over llm_usage)
  costTotal: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // detected deterministic failures
  failures: Failure[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Byte-stable JSON serialization: sorts object keys recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Normalize text for REP-3 comparison: lowercase, collapse whitespace, strip punctuation edges. */
function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A text is "substantive" for REP-3 when it carries real content (not an ack). */
function isSubstantive(t: string): boolean {
  return normalizeText(t).length >= 80;
}

/** The effective tool identity: for execute-tool wrappers, app/innerTool; else the tool name. */
function effectiveToolName(c: EvalToolCall): string {
  return c.innerTool ? `${c.app ?? ''}/${c.innerTool}` : c.tool;
}

/** Heuristic: does this tool expose a search/filter capability in its input? */
const SEARCH_FILTER_KEYS = /^(q|query|search|filter|where|match|find|searchquery|searchterm|term|keyword|text)$/i;
function inputHasSearchFilter(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.keys(input as Record<string, unknown>).some((k) => SEARCH_FILTER_KEYS.test(k));
}

/** Heuristic: is this call a pagination step? (page/cursor/offset/limit in input, or tool name says so) */
const PAGINATION_KEYS = /^(page|pagenumber|pageindex|cursor|offset|after|next|nextcursor|nextpage|startat|skip)$/i;
function isPaginationCall(c: EvalToolCall): boolean {
  if (/get-?(chats|messages|list|history)|list-|getchats|getmessages/i.test(effectiveToolName(c))) {
    if (inputHasKey(c.input, PAGINATION_KEYS)) return true;
  }
  return inputHasKey(c.input, PAGINATION_KEYS);
}
function inputHasKey(input: unknown, re: RegExp): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.keys(input as Record<string, unknown>).some((k) => re.test(k));
}

/** Tools that reveal schema — consulting them breaks an RTX-2 "blind guessing" chain. */
const SCHEMA_SOURCE_TOOLS = new Set(['list-app-tools', 'list-installed-apps']);

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectRep1(flat: EvalToolCall[], messages: EvalMessage[]): Failure[] {
  // Flatten tool calls in time order, tracking whether a user message intervenes.
  // Build an event stream: tool calls and user messages, both time-ordered.
  type Ev = { kind: 'tool'; c: EvalToolCall } | { kind: 'user' };
  const evs: Ev[] = [];
  for (const m of messages) {
    if (m.role === 'user') evs.push({ kind: 'user' });
    for (const c of m.toolCalls) evs.push({ kind: 'tool', c });
  }
  evs.sort((a, b) => {
    const ta = a.kind === 'tool' ? a.c.startedAt : 0;
    const tb = b.kind === 'tool' ? b.c.startedAt : 0;
    return ta - tb;
  });
  // NOTE: user events carry no timestamp in this flat form; instead we rely on the
  // per-message ordering below. Rebuild properly:
  const stream: Ev[] = [];
  const sortedMsgs = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  for (const m of sortedMsgs) {
    if (m.role === 'user') stream.push({ kind: 'user' });
    const calls = [...m.toolCalls].sort((a, b) => a.startedAt - b.startedAt);
    for (const c of calls) stream.push({ kind: 'tool', c });
  }

  const failures: Failure[] = [];
  let run: EvalToolCall[] = [];
  const flush = () => {
    if (run.length >= 3) {
      failures.push({
        code: 'REP-1',
        severity: 'critical',
        detector: 'det',
        evidence: {
          callIds: run.map((c) => c.callId),
          tool: effectiveToolName(run[0]),
          detail: `${run.length} consecutive identical calls`,
        },
      });
    }
    run = [];
  };
  for (const ev of stream) {
    if (ev.kind === 'user') {
      flush();
      continue;
    }
    const c = ev.c;
    const key = `${effectiveToolName(c)}|${c.inputKey}`;
    if (run.length === 0) {
      run = [c];
      continue;
    }
    const lastKey = `${effectiveToolName(run[run.length - 1])}|${run[run.length - 1].inputKey}`;
    if (key === lastKey) {
      run.push(c);
    } else {
      flush();
      run = [c];
    }
  }
  flush();
  return failures;
}

function detectRep3(messages: EvalMessage[]): Failure[] {
  // Same substantive assistant text to the user >=2 times.
  const assistantTexts = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'assistant' && isSubstantive(m.text));
  const seen = new Map<string, number[]>();
  for (const { m, i } of assistantTexts) {
    const key = normalizeText(m.text);
    const arr = seen.get(key) ?? [];
    arr.push(i);
    seen.set(key, arr);
  }
  const failures: Failure[] = [];
  for (const [, idxs] of seen) {
    if (idxs.length >= 2) {
      failures.push({
        code: 'REP-3',
        severity: 'high',
        detector: 'det',
        evidence: { messageIndexes: idxs, detail: `same substantive assistant text ${idxs.length}x` },
      });
    }
  }
  return failures;
}

function detectRtx1(messages: EvalMessage[]): Failure[] {
  // Retry after error: same tool + same input >=1 time after the error.
  const stream = flattenCalls(messages);
  const failures: Failure[] = [];
  for (let i = 0; i < stream.length; i++) {
    const c = stream[i];
    if (c.status !== 'error') continue;
    const key = `${effectiveToolName(c)}|${c.inputKey}`;
    const retryIds: string[] = [];
    for (let j = i + 1; j < stream.length; j++) {
      const r = stream[j];
      const rkey = `${effectiveToolName(r)}|${r.inputKey}`;
      if (rkey === key) retryIds.push(r.callId);
    }
    if (retryIds.length >= 1) {
      failures.push({
        code: 'RTX-1',
        severity: 'critical',
        detector: 'det',
        evidence: {
          callIds: [c.callId, ...retryIds],
          tool: effectiveToolName(c),
          detail: `identical retry after error (${retryIds.length}x)`,
        },
      });
    }
  }
  return failures;
}

function detectRtx2(messages: EvalMessage[]): Failure[] {
  // Blind schema guessing (protocol §4 RTX-2): after an error, the agent retries with
  // arbitrary changes — renaming a param, adding/removing one, OR renaming the tool
  // itself after a "no such tool" / "missing required parameter" error — WITHOUT
  // consulting list-app-tools (or any schema source) in between.
  //
  // Two shapes observed in real data (golden case ch_d79cd956fa9c30b1):
  //   (a) same tool, input changed, both error (classic param guessing)
  //   (b) "no such tool"/"missing param" error -> retry with a renamed tool/param
  //       (the retry may succeed — the failure is the blind guess, not the outcome)
  const stream = flattenCalls(messages);
  const failures: Failure[] = [];
  const NO_SUCH_TOOL = /has no tool|missing required parameter|unknown tool|tool .* not found|does not exist/i;
  let consultedSchemaAt = -1;
  for (let i = 0; i < stream.length; i++) {
    const c = stream[i];
    if (SCHEMA_SOURCE_TOOLS.has(c.tool)) consultedSchemaAt = i;
    if (c.status !== 'error') continue;
    // look ahead to the next call, skipping unrelated tools
    for (let j = i + 1; j < stream.length; j++) {
      const r = stream[j];
      if (SCHEMA_SOURCE_TOOLS.has(r.tool)) break; // schema consulted — chain broken
      const sameTool = effectiveToolName(r) === effectiveToolName(c);
      // (a) same tool, input changed, also errors
      if (sameTool && r.inputKey !== c.inputKey && r.status === 'error' && consultedSchemaAt < i) {
        failures.push({
          code: 'RTX-2',
          severity: 'medium',
          detector: 'det',
          evidence: {
            callIds: [c.callId, r.callId],
            tool: effectiveToolName(c),
            detail: 'error -> params changed -> error, no schema consultation',
          },
        });
        break;
      }
      // (b) "no such tool"/"missing param" error -> blind rename (tool or param), no schema consult
      if (consultedSchemaAt < i && c.errorFirstLine && NO_SUCH_TOOL.test(c.errorFirstLine)) {
        // renamed tool after no-such-tool error
        if (!sameTool && r.status !== 'error') {
          failures.push({
            code: 'RTX-2',
            severity: 'medium',
            detector: 'det',
            evidence: {
              callIds: [c.callId, r.callId],
              tool: `${effectiveToolName(c)} -> ${effectiveToolName(r)}`,
              detail: 'blind tool rename after no-such-tool error, no schema consultation',
            },
          });
          break;
        }
        // same tool but params added/renamed after missing-param error (retry may succeed)
        if (sameTool && r.inputKey !== c.inputKey) {
          failures.push({
            code: 'RTX-2',
            severity: 'medium',
            detector: 'det',
            evidence: {
              callIds: [c.callId, r.callId],
              tool: effectiveToolName(c),
              detail: 'blind param change after missing-parameter error, no schema consultation',
            },
          });
          break;
        }
      }
      if (sameTool && r.inputKey === c.inputKey) continue; // identical retry = RTX-1 territory
      if (sameTool) break; // same tool consulted schema or succeeded — stop this chain
    }
  }
  return failures;
}

function detectIne1(messages: EvalMessage[]): Failure[] {
  // >=10 pagination calls to the same tool, dominating a window of consecutive calls,
  // when a search/filter was available on the same tool or an equivalent one.
  //
  // Real data (golden case ch_d79cd956fa9c30b1): the agent paginates get-chats with
  // offset 0->330 but interleaves an occasional search-chats / health-check. A strict
  // "consecutive" rule under-counts; the protocol's intent is "walked the list end to
  // end". So we use a sliding window: >=10 pagination calls to the same tool within any
  // window of <=15 consecutive calls (pagination dominates the window).
  const stream = flattenCalls(messages);
  const failures: Failure[] = [];
  const WINDOW = 15;
  const MIN_PAGES = 10;
  const reported = new Set<string>();
  for (let i = 0; i < stream.length; i++) {
    const c = stream[i];
    if (!isPaginationCall(c)) continue;
    const tool = effectiveToolName(c);
    // gather the window starting at i
    const windowCalls: EvalToolCall[] = [];
    const pageCalls: EvalToolCall[] = [];
    for (let j = i; j < stream.length && windowCalls.length < WINDOW; j++) {
      const w = stream[j];
      windowCalls.push(w);
      if (isPaginationCall(w) && effectiveToolName(w) === tool) pageCalls.push(w);
    }
    if (pageCalls.length >= MIN_PAGES && !reported.has(tool)) {
      // search/filter available on same tool OR equivalent (sibling search-* used)
      const toolHasSearch = stream.some(
        (x) => effectiveToolName(x) === tool && inputHasSearchFilter(x.input),
      );
      const siblingSearchUsed = stream.some((x) => /(^|\/)search[-_]?/i.test(effectiveToolName(x)));
      if (toolHasSearch || siblingSearchUsed) {
        reported.add(tool);
        failures.push({
          code: 'INE-1',
          severity: 'medium',
          detector: 'det',
          evidence: {
            callIds: pageCalls.map((c) => c.callId),
            tool,
            detail: `${pageCalls.length} pagination calls in a ${windowCalls.length}-call window (search/filter available)`,
          },
        });
      }
    }
  }
  return failures;
}

function detectIne2(messages: EvalMessage[]): Failure[] {
  // >=8 one-by-one calls (same tool, varying single-item identifier) when a bulk/filter
  // alternative existed. Proxy for "bulk alternative": the tool accepts an array/ids key
  // OR a search/filter key (observed somewhere in the conversation), or the tool name
  // matches a known one-by-one pattern (get-message, get-chat, get-task, ...).
  const stream = flattenCalls(messages);
  const byTool = new Map<string, EvalToolCall[]>();
  for (const c of stream) {
    const t = effectiveToolName(c);
    const arr = byTool.get(t) ?? [];
    arr.push(c);
    byTool.set(t, arr);
  }
  const failures: Failure[] = [];
  for (const [tool, calls] of byTool) {
    if (calls.length < 8) continue;
    // one-by-one signature: many calls to the same tool with DIFFERENT inputs, each
    // input small (<=3 keys) and containing an id-like key.
    const idLike = /^(id|.*id|chatid|messageid|taskid|userid|channelid|path|filepath|name|key)$/i;
    const oneByOne = calls.filter((c) => {
      if (!c.input || typeof c.input !== 'object' || Array.isArray(c.input)) return false;
      const keys = Object.keys(c.input as Record<string, unknown>);
      return keys.length <= 3 && keys.some((k) => idLike.test(k));
    });
    if (oneByOne.length < 8) continue;
    // bulk/filter alternative: same tool seen with a search/filter/list key, or tool name
    // suggests a list sibling exists (get-X -> list-X / get-Xs).
    const hasBulk = calls.some((c) => inputHasSearchFilter(c.input)) || /get-|fetch-|read-/i.test(tool);
    if (hasBulk) {
      failures.push({
        code: 'INE-2',
        severity: 'medium',
        detector: 'det',
        evidence: {
          callIds: oneByOne.map((c) => c.callId),
          tool,
          detail: `${oneByOne.length} one-by-one calls (bulk/filter alternative)`,
        },
      });
    }
  }
  return failures;
}

function detectIne3(messages: EvalMessage[], rep1CallIds: Set<string>): Failure[] {
  // Redundant calls: same tool+input already succeeded earlier in the conversation.
  // Calls already attributed to a REP-1 loop are excluded (REP-1 is the more specific,
  // critical diagnosis of the same behavior — INE-3 would double-count it).
  const stream = flattenCalls(messages);
  const succeeded = new Map<string, EvalToolCall>();
  const failures: Failure[] = [];
  for (const c of stream) {
    if (rep1CallIds.has(c.callId)) continue;
    const key = `${effectiveToolName(c)}|${c.inputKey}`;
    if (c.status === 'completed') {
      if (succeeded.has(key)) {
        failures.push({
          code: 'INE-3',
          severity: 'medium',
          detector: 'det',
          evidence: {
            callIds: [succeeded.get(key)!.callId, c.callId],
            tool: effectiveToolName(c),
            detail: 'same tool+input already succeeded earlier',
          },
        });
      } else {
        succeeded.set(key, c);
      }
    }
  }
  return failures;
}

function flattenCalls(messages: EvalMessage[]): EvalToolCall[] {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const out: EvalToolCall[] = [];
  for (const m of sorted) {
    out.push(...[...m.toolCalls].sort((a, b) => a.startedAt - b.startedAt));
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function extractConversationMetrics(input: EvalInput): ConversationMetrics {
  const { channelId, messages, llmUsage } = input;

  const userMessages = messages.filter((m) => m.role === 'user');
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const voiceMessages = userMessages.filter((m) => m.isVoice).length;

  const calls = flattenCalls(messages);
  const toolCallsTotal = calls.length;
  const toolCallsCompleted = calls.filter((c) => c.status === 'completed').length;
  const toolCallsError = calls.filter((c) => c.status === 'error').length;
  const toolErrorRate = toolCallsTotal > 0 ? toolCallsError / toolCallsTotal : 0;
  const uniqueKeys = new Set(calls.map((c) => `${effectiveToolName(c)}|${c.inputKey}`));
  const uniqueCallRatio = toolCallsTotal > 0 ? uniqueKeys.size / toolCallsTotal : 1;

  const stopReasons: Record<string, number> = {};
  let costTotal = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let steps = 0;
  const tsList: number[] = [];
  for (const u of llmUsage) {
    if (u.stopReason) stopReasons[u.stopReason] = (stopReasons[u.stopReason] ?? 0) + 1;
    if (u.messageId) steps++;
    costTotal += u.costTotal ?? 0;
    promptTokens += u.promptTokens ?? 0;
    completionTokens += u.completionTokens ?? 0;
    totalTokens += u.totalTokens ?? 0;
    if (u.timestamp) tsList.push(u.timestamp);
  }
  tsList.sort((a, b) => a - b);
  const msgTs = messages.map((m) => m.createdAt).filter(Boolean).sort((a, b) => a - b);
  const t0 = tsList[0] ?? msgTs[0] ?? 0;
  const t1 = tsList[tsList.length - 1] ?? msgTs[msgTs.length - 1] ?? 0;
  const durationMs = Math.max(0, t1 - t0);

  const rep1 = detectRep1(calls, messages);
  const rep1CallIds = new Set(rep1.flatMap((f) => f.evidence.callIds ?? []));
  const failures: Failure[] = [
    ...rep1,
    ...detectRep3(messages),
    ...detectRtx1(messages),
    ...detectRtx2(messages),
    ...detectIne1(messages),
    ...detectIne2(messages),
    ...detectIne3(messages, rep1CallIds),
  ];

  return {
    channelId,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    voiceMessages,
    toolCallsTotal,
    toolCallsCompleted,
    toolCallsError,
    toolErrorRate,
    uniqueCallRatio,
    stopReasons,
    steps,
    durationMs,
    costTotal,
    promptTokens,
    completionTokens,
    totalTokens,
    failures,
  };
}
