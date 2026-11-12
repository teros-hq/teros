/**
 * evaluator actions — Conversation Evaluator L2 backend capability.
 *
 * Spec: docs/specs/20261015_conversation-evaluator.md
 * Task: task_db265dd9a4e8d376 (fase 3)
 *
 * Thin-client target for `mca.teros.admin.evaluator` (datastore-isolation P1b:
 * the MCA never holds a Mongo connection; every tool forwards here).
 *
 * Actions:
 *   evaluator/extract       — L1 deterministic metrics for one channelId.
 *                             Reuses the PURE extractor from @teros/shared/evaluator
 *                             (the Mongo→EvalInput mapping used to live in
 *                             scripts/eval/backfill-l1-v0.mjs; it is now here).
 *   evaluator/conversation  — the conversation partitioned into FULL-READ
 *                             windows (Pablo's rule: zero condensation, no
 *                             overlap, no gaps, accumulated state echoed).
 *   evaluator/record        — writes the evaluation record into
 *                             `conversation_evaluations` (schema spec §7),
 *                             enforcing the two-table separation via
 *                             detectorLayer (det = technical, llm = behavioral).
 *
 * Eligibility (Pablo's strict single-model rule, spec §2): exactly one
 * distinct modelId among llm_usage rows WITH a messageId. Applied
 * server-side in extract and conversation; multi-model → 422 with reason.
 *
 * Authorization: system admin only (same gate as feedback-admin).
 */

import type { Db } from 'mongodb';
import {
  anonymizeChannelId,
  anonymizeEvalMessages,
  anonymizeWindowMessages,
  BEH_CODES,
  buildWindow,
  computeWindowBounds,
  DEFAULT_WINDOW_SIZE,
  emptyAccumulatedState,
  extractConversationMetrics,
  INTENT_VOCABULARY,
  LLM_FAILURE_CODES,
  MAX_WINDOW_SIZE,
  OUTCOMES,
  stableStringify,
  TECH_FAILURE_CODES,
  type EvalInput,
  type EvalLlmUsageRow,
  type EvalMessage,
  type WindowAccumulatedState,
  type WindowMessage,
  type WindowPart,
} from '@teros/shared/evaluator';
import { requireSystemAdmin } from '../auth/auth-helpers';
import { COLLECTIONS } from '../db';
import { HandlerError } from '../ws-framework/WsRouter';
import { McaActionError } from './errors';
import type { McaActionCapability, McaActionCtx } from './index';

const MCA_ID = 'mca.teros.admin.evaluator';

/** Evaluator identity stamped on every record (versioning is non-negotiable, spec §7). */
const TAXONOMY_VERSION = 'v0.1+beh-v0';
const VOCABULARY_VERSION = 'intents-v0.1';
const PROMPT_VERSION = 'evaluator-l2-v0';
/** When true, all content sent to the evaluator is pseudonymized (fase 4a rule). */
const ANONYMIZE_BEFORE_EVAL = true;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HandlerError('BAD_REQUEST', `${field} is required`);
  }
  return value;
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HandlerError('BAD_REQUEST', `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

async function requireAdmin(db: Db, ctx: McaActionCtx): Promise<string> {
  if (!ctx.userId) throw new HandlerError('FORBIDDEN', 'No authenticated user for this token');
  await requireSystemAdmin(db, ctx.userId);
  return ctx.userId;
}

// ---------------------------------------------------------------------------
// Mongo → EvalInput / WindowMessage mapping (moved from scripts/eval/backfill-l1-v0.mjs)
// ---------------------------------------------------------------------------

interface SessionPart {
  id?: string;
  type?: string;
  tool?: string;
  callID?: string;
  text?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number };
  };
}

interface SessionDoc {
  info?: { id?: string; role?: string; time?: { created?: number } };
  parts?: SessionPart[];
}

interface ConsolidatedMessage {
  role: string;
  createdAt: number;
  parts: SessionPart[];
}

/** Load + consolidate session_messages for a channel (multiple docs can share info.id). */
async function loadSessionMessages(db: Db, channelId: string): Promise<ConsolidatedMessage[]> {
  const sess = (await db
    .collection('session_messages')
    .find({ sessionId: channelId })
    .project({ 'info.id': 1, 'info.role': 1, 'info.time.created': 1, parts: 1 })
    .toArray()) as unknown as SessionDoc[];
  const byId = new Map<string, ConsolidatedMessage>();
  for (const doc of sess) {
    const info = doc.info;
    const id = info?.id;
    if (!id || !info) continue;
    const e = byId.get(id) || { role: info.role || 'system', createdAt: info.time?.created || 0, parts: [] };
    e.role = info.role || e.role;
    e.createdAt = info.time?.created || e.createdAt;
    e.parts.push(...(doc.parts || []));
    byId.set(id, e);
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Voice flags come from channel_messages (user-facing source of truth). */
async function loadVoiceTimestamps(db: Db, channelId: string): Promise<number[]> {
  const rows = await db
    .collection('channel_messages')
    .find({ channelId, role: 'user', 'content.type': 'voice' })
    .project({ timestamp: 1 })
    .toArray();
  return rows.map((m) => new Date(m.timestamp as unknown as string).getTime());
}

function toEvalMessages(consolidated: ConsolidatedMessage[], voiceTs: number[]): EvalMessage[] {
  const messages = consolidated.map((m) => {
    const texts = m.parts.filter((p) => p.type === 'text').map((p) => p.text || '');
    const toolCalls = m.parts
      .filter((p) => p.type === 'tool')
      .map((p) => {
        const st = p.state || {};
        const rawInput = st.input ?? {};
        const isWrapper = p.tool === 'execute-tool' && rawInput && typeof rawInput === 'object' && 'tool' in rawInput;
        const wrapped = rawInput as { app?: string; tool?: string; input?: unknown };
        const app = isWrapper ? wrapped.app : undefined;
        const innerTool = isWrapper ? wrapped.tool : undefined;
        const canonical = isWrapper ? wrapped.input ?? {} : rawInput;
        return {
          callId: p.callID || p.id || '',
          tool: p.tool || '',
          app,
          innerTool,
          input: canonical,
          inputKey: stableStringify(canonical),
          status: (st.status === 'error' ? 'error' : st.status === 'completed' ? 'completed' : 'unknown') as
            | 'error'
            | 'completed'
            | 'unknown',
          errorFirstLine: st.error ? String(st.error).split('\n')[0] : undefined,
          startedAt: st.time?.start ?? m.createdAt,
          endedAt: st.time?.end,
        };
      });
    return {
      role: (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system') as EvalMessage['role'],
      createdAt: m.createdAt,
      text: texts.join('\n'),
      isVoice: false,
      toolCalls,
    };
  });
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (voiceTs.some((t) => Math.abs(t - msg.createdAt) <= 5000)) msg.isVoice = true;
  }
  return messages;
}

/** Full-fidelity window messages: whole texts, whole inputs, whole errors, whole outputs. */
function toWindowMessages(consolidated: ConsolidatedMessage[], voiceTs: number[]): WindowMessage[] {
  const sorted = consolidated; // already sorted by createdAt
  return sorted.map((m, index) => {
    const parts: WindowPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') {
        parts.push({ kind: 'text', text: p.text || '' });
      } else if (p.type === 'tool') {
        const st = p.state || {};
        const rawInput = st.input ?? {};
        const isWrapper = p.tool === 'execute-tool' && rawInput && typeof rawInput === 'object' && 'tool' in rawInput;
        const wrapped = rawInput as { app?: string; tool?: string; input?: unknown };
        const effectiveTool = isWrapper ? `${wrapped.app ?? ''}/${wrapped.tool ?? ''}` : p.tool || '';
        const canonical = isWrapper ? wrapped.input ?? {} : rawInput;
        const output = st.output === undefined || st.output === null ? undefined : String(st.output);
        parts.push({
          kind: 'tool',
          callId: p.callID || p.id || '',
          tool: effectiveTool,
          input: canonical,
          status: st.status === 'error' ? 'error' : st.status === 'completed' ? 'completed' : 'unknown',
          error: st.error ? String(st.error) : undefined,
          output,
          truncatedBytes: 0,
          startedAt: st.time?.start ?? m.createdAt,
          endedAt: st.time?.end,
        });
      }
    }
    const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system';
    const isVoice = role === 'user' && voiceTs.some((t) => Math.abs(t - m.createdAt) <= 5000);
    return { index, role, createdAt: m.createdAt, isVoice, parts };
  });
}

function toEvalLlmUsage(rows: Record<string, unknown>[]): EvalLlmUsageRow[] {
  return rows.map((u) => ({
    modelId: String(u.modelId ?? ''),
    provider: u.provider as string | undefined,
    messageId: u.messageId as string | undefined,
    timestamp:
      u.timestamp instanceof Date ? u.timestamp.getTime() : new Date(u.timestamp as string).getTime(),
    promptTokens: (u.promptTokens as number) ?? 0,
    completionTokens: (u.completionTokens as number) ?? 0,
    totalTokens: (u.totalTokens as number) ?? 0,
    costTotal: (u.costTotal as number) ?? 0,
    latencyMs: (u.latencyMs as number) ?? 0,
    stopReason: (u.stopReason as string) ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Eligibility — Pablo's strict single-model rule (spec §2), server-side
// ---------------------------------------------------------------------------

interface Eligibility {
  eligible: boolean;
  reason?: 'channel_not_found' | 'ineligible_no_usage' | 'ineligible_multi_model';
  modelId?: string;
  provider?: string;
  modelSwitches?: number;
  usageRows: Record<string, unknown>[];
}

async function checkEligibility(db: Db, channelId: string): Promise<Eligibility> {
  const ch = await db.collection('channels').findOne({ channelId });
  if (!ch) return { eligible: false, reason: 'channel_not_found', usageRows: [] };
  const usageRows = await db.collection('llm_usage').find({ channelId }).toArray();
  if (usageRows.length === 0) return { eligible: false, reason: 'ineligible_no_usage', usageRows };
  const turnModels = [...new Set(usageRows.filter((r) => r.messageId).map((r) => String(r.modelId)))];
  if (turnModels.length !== 1) {
    return { eligible: false, reason: 'ineligible_multi_model', modelSwitches: turnModels.length, usageRows };
  }
  const provider = usageRows.find((r) => r.messageId)?.provider as string | undefined;
  return { eligible: true, modelId: turnModels[0], provider, modelSwitches: 0, usageRows };
}

function assertEligible(e: Eligibility): void {
  if (e.eligible) return;
  const status = e.reason === 'channel_not_found' ? 404 : 422;
  throw new HandlerError(
    e.reason === 'channel_not_found' ? 'NOT_FOUND' : 'INELIGIBLE',
    `Conversation excluded: ${e.reason}${e.modelSwitches ? ` (${e.modelSwitches} models)` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Consent gate — user opt-in, default OFF (task_047a4844b9103db3)
// ---------------------------------------------------------------------------

/**
 * Pablo's hard privacy guarantee (2026-10-26): a conversation enters the
 * evaluation pipeline only if its owner explicitly opted in from Profile
 * ("Help improve Teros"). Enforced server-side on every evaluator/* action —
 * an admin launching the evaluation cannot bypass it; privacy does not
 * depend on the operator's good faith. Rejection carries reason `no_consent`
 * (422) so the evaluator agent can report it without retrying.
 */
async function assertOwnerConsented(db: Db, channelId: string): Promise<void> {
  const channel = await db.collection('channels').findOne(
    { channelId },
    { projection: { userId: 1 } },
  );
  if (!channel) {
    // Same answer checkEligibility would give — a missing channel is NOT_FOUND,
    // never a consent question.
    throw new HandlerError('NOT_FOUND', 'Conversation not found');
  }
  if (!channel.userId) {
    // A channel without an owner cannot prove consent → treated as no consent.
    throw new McaActionError('NO_CONSENT', 'Conversation excluded: no_consent (owner has not opted in)', 422);
  }
  const owner = await db.collection('users').findOne(
    { userId: channel.userId },
    { projection: { 'consent.evaluationOptIn': 1 } },
  );
  if (owner?.consent?.evaluationOptIn !== true) {
    throw new McaActionError('NO_CONSENT', 'Conversation excluded: no_consent (owner has not opted in)', 422);
  }
}

// ---------------------------------------------------------------------------
// Record validation (evaluator/record)
// ---------------------------------------------------------------------------

const ALL_FAILURE_CODES = new Set<string>([
  ...TECH_FAILURE_CODES,
  ...LLM_FAILURE_CODES,
  ...BEH_CODES,
]);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

/** Codes the deterministic L1 layer owns. The evaluator must not re-emit them as llm. */
function expectedLayerFor(code: string): 'det' | 'llm' {
  return (TECH_FAILURE_CODES as readonly string[]).includes(code) ? 'det' : 'llm';
}

interface RecordFailureInput {
  code: string;
  severity: string;
  confidence: string;
  evidence: { messageIndexes?: number[]; callIds?: string[]; tool?: string; detail?: string };
  detectorLayer: 'det' | 'llm';
}

function validateFailures(raw: unknown): RecordFailureInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HandlerError('BAD_REQUEST', 'failures must be an array');
  return raw.map((f, i) => {
    const o = f as Record<string, unknown>;
    const code = requiredString(o.code, `failures[${i}].code`);
    if (!ALL_FAILURE_CODES.has(code) && !code.startsWith('BEH-')) {
      throw new HandlerError('BAD_REQUEST', `failures[${i}].code '${code}' is not in the taxonomy (use BEH-other with a note for new behavioral patterns)`);
    }
    const severity = requiredString(o.severity, `failures[${i}].severity`);
    if (!SEVERITIES.has(severity)) throw new HandlerError('BAD_REQUEST', `failures[${i}].severity invalid`);
    const confidence = typeof o.confidence === 'string' && CONFIDENCES.has(o.confidence) ? o.confidence : 'medium';
    const detectorLayer = expectedLayerFor(code);
    // Enforce the two-table separation: det codes stay det, everything else is llm.
    // A caller-supplied detectorLayer that contradicts the family is rejected.
    if (o.detectorLayer !== undefined && o.detectorLayer !== detectorLayer) {
      throw new HandlerError(
        'BAD_REQUEST',
        `failures[${i}].detectorLayer mismatch: code ${code} belongs to layer '${detectorLayer}'`,
      );
    }
    const evidence = (o.evidence ?? {}) as Record<string, unknown>;
    const messageIndexes = Array.isArray(evidence.messageIndexes)
      ? evidence.messageIndexes.filter((x): x is number => typeof x === 'number')
      : undefined;
    const callIds = Array.isArray(evidence.callIds)
      ? evidence.callIds.filter((x): x is string => typeof x === 'string')
      : undefined;
    if ((!messageIndexes || messageIndexes.length === 0) && (!callIds || callIds.length === 0)) {
      throw new HandlerError('BAD_REQUEST', `failures[${i}] requires evidence (messageIndexes and/or callIds) — evidence is auditable, never optional`);
    }
    return {
      code,
      severity,
      confidence,
      detectorLayer,
      evidence: {
        messageIndexes,
        callIds,
        // fase 4b: tool name rides with det evidence so the tool x code table
        // comes free from records (no second pass over session_messages)
        tool: typeof evidence.tool === 'string' ? evidence.tool : undefined,
        detail: typeof evidence.detail === 'string' ? evidence.detail : undefined,
      },
    };
  });
}

function validateIntents(raw: unknown): Array<{ id: string; primary: boolean; justification?: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HandlerError('BAD_REQUEST', 'intents must be a non-empty array (multi-intent allowed, primary required)');
  }
  const intents = raw.map((it, i) => {
    const o = it as Record<string, unknown>;
    const id = requiredString(o.id, `intents[${i}].id`);
    if (!(INTENT_VOCABULARY as readonly string[]).includes(id)) {
      throw new HandlerError('BAD_REQUEST', `intents[${i}].id '${id}' not in vocabulary (use 'other' with justification)`);
    }
    const justification = typeof o.justification === 'string' ? o.justification : undefined;
    if (id === 'other' && !justification) {
      throw new HandlerError('BAD_REQUEST', `intents[${i}]: 'other' requires a free-text justification`);
    }
    return { id, primary: o.primary === true, justification };
  });
  const primaries = intents.filter((i) => i.primary);
  if (primaries.length !== 1) {
    throw new HandlerError('BAD_REQUEST', `exactly one intent must be marked primary (got ${primaries.length})`);
  }
  return intents;
}

function validateAccumulated(raw: unknown): WindowAccumulatedState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HandlerError('BAD_REQUEST', 'accumulated must be an object');
  }
  const o = raw as Record<string, unknown>;
  const base = emptyAccumulatedState();
  if (Array.isArray(o.intents)) base.intents = o.intents as WindowAccumulatedState['intents'];
  if (Array.isArray(o.failures)) base.failures = o.failures as WindowAccumulatedState['failures'];
  if (Array.isArray(o.featureRequests)) {
    base.featureRequests = o.featureRequests as WindowAccumulatedState['featureRequests'];
  }
  if (typeof o.notes === 'string') base.notes = o.notes.slice(0, 4000);
  return base;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export const evaluatorCapability: McaActionCapability = {
  mcaId: MCA_ID,
  actions: {
    /**
     * evaluator/extract — L1 deterministic metrics for one conversation.
     * Server-side single-model eligibility (strict).
     */
    async extract(ctx, db, body) {
      await requireAdmin(db, ctx);
      const channelId = requiredString(body.channelId, 'channelId');

      await assertOwnerConsented(db, channelId);
      const eligibility = await checkEligibility(db, channelId);
      assertEligible(eligibility);

      const [consolidated, voiceTs] = await Promise.all([
        loadSessionMessages(db, channelId),
        loadVoiceTimestamps(db, channelId),
      ]);
      const messages = toEvalMessages(consolidated, voiceTs);
      const llmUsage = toEvalLlmUsage(eligibility.usageRows);
      const evalMessages = ANONYMIZE_BEFORE_EVAL ? anonymizeEvalMessages(messages) : messages;
      const input: EvalInput = { channelId, messages: evalMessages, llmUsage };
      const metrics = extractConversationMetrics(input);
      metrics.voiceMessages = voiceTs.length;

      return {
        channelId: ANONYMIZE_BEFORE_EVAL ? anonymizeChannelId(channelId) : channelId,
        eligible: true,
        modelId: eligibility.modelId,
        provider: eligibility.provider,
        metrics,
      };
    },

    /**
     * evaluator/conversation — one full-read window of the conversation.
     * Windows never overlap and never leave gaps; every message appears exactly
     * once, whole. The caller passes the accumulated state from the previous
     * window; it is validated and echoed through.
     */
    async conversation(ctx, db, body) {
      await requireAdmin(db, ctx);
      const channelId = requiredString(body.channelId, 'channelId');
      const windowSize = optionalInt(body.windowSize, 'windowSize', 1, MAX_WINDOW_SIZE) ?? DEFAULT_WINDOW_SIZE;

      await assertOwnerConsented(db, channelId);
      const eligibility = await checkEligibility(db, channelId);
      assertEligible(eligibility);

      const [consolidated, voiceTs] = await Promise.all([
        loadSessionMessages(db, channelId),
        loadVoiceTimestamps(db, channelId),
      ]);
      const allMessages = toWindowMessages(consolidated, voiceTs);
      const bounds = computeWindowBounds(allMessages.length, windowSize);
      const windowCount = Math.max(1, bounds.length);
      const windowIndex = optionalInt(body.windowIndex, 'windowIndex', 0, windowCount - 1) ?? 0;
      const accumulated = validateAccumulated(body.accumulated);

      const windowMessages = ANONYMIZE_BEFORE_EVAL ? anonymizeWindowMessages(allMessages) : allMessages;
      const win = buildWindow(channelId, windowMessages, windowIndex, { windowSize }, accumulated);
      return {
        ...win,
        channelId: ANONYMIZE_BEFORE_EVAL ? anonymizeChannelId(channelId) : win.channelId,
        modelId: eligibility.modelId,
        provider: eligibility.provider,
      };
    },

    /**
     * evaluator/record — persist the evaluation record (schema spec §7).
     * Upserts by (channelId, evaluator.promptVersion) so re-runs replace, not pile up.
     */
    async record(ctx, db, body) {
      const adminUserId = await requireAdmin(db, ctx);
      const channelId = requiredString(body.channelId, 'channelId');

      await assertOwnerConsented(db, channelId);
      const eligibility = await checkEligibility(db, channelId);
      assertEligible(eligibility);

      const intents = validateIntents(body.intents);
      const outcome = requiredString(body.outcome, 'outcome');
      if (!(OUTCOMES as readonly string[]).includes(outcome)) {
        throw new HandlerError('BAD_REQUEST', `outcome must be one of ${OUTCOMES.join(', ')}`);
      }
      const failures = validateFailures(body.failures);
      const scenarioFingerprint = requiredString(body.scenarioFingerprint, 'scenarioFingerprint');
      const scenario = (body.scenario ?? {}) as Record<string, unknown>;
      const metrics = (body.metrics ?? {}) as Record<string, unknown>;
      const synthesis = typeof body.synthesis === 'string' ? body.synthesis.slice(0, 8000) : undefined;

      // Consistency: outcome achieved cannot carry OUT-1/OUT-2 (protocol §4).
      if (outcome === 'achieved' && failures.some((f) => f.code === 'OUT-1' || f.code === 'OUT-2')) {
        throw new HandlerError('BAD_REQUEST', "outcome 'achieved' is inconsistent with OUT-1/OUT-2 failures");
      }

      const now = new Date().toISOString();
      const doc = {
        channelId,
        evaluatedAt: now,
        scenarioFingerprint,
        scenario: {
          modelId: eligibility.modelId,
          provider: eligibility.provider,
          coreId: scenario.coreId,
          coreVersion: scenario.coreVersion,
          flags: scenario.flags ?? {},
          attribution: scenario.attribution ?? 'reconstructed',
        },
        intents,
        outcome,
        failures,
        metrics,
        synthesis,
        evaluator: {
          agentId: ctx.appId ?? 'mca-action',
          modelId: typeof body.evaluatorModelId === 'string' ? body.evaluatorModelId : undefined,
          promptVersion: PROMPT_VERSION,
          taxonomyVersion: TAXONOMY_VERSION,
          vocabularyVersion: VOCABULARY_VERSION,
        },
        recordedBy: adminUserId,
        status: 'evaluated' as const,
        updatedAt: now,
      };

      // Indexes (unique channelId + promptVersion) are declared in src/db/indexes.ts.
      const col = db.collection(COLLECTIONS.conversationEvaluations);
      const result = await col.findOneAndUpdate(
        { channelId, 'evaluator.promptVersion': PROMPT_VERSION },
        { $set: doc, $setOnInsert: { evaluationId: `ev_${Math.random().toString(36).slice(2, 14)}`, createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      return { success: true, evaluationId: result?.evaluationId, channelId, failuresRecorded: failures.length };
    },
  },
};
