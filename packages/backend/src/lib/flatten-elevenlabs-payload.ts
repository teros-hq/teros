/**
 * Flatten the ElevenLabs `post_call_transcription` webhook payload.
 *
 * ElevenLabs delivers the post-call webhook nested under `data`:
 *   { type, event_timestamp, data: { conversation_id, agent_id, status,
 *     transcript, analysis: { transcript_summary, call_successful },
 *     metadata: { call_duration_secs, termination_reason, cost } } }
 *
 * The bus consumers (channel/agent subscription rules, Automate starter
 * filters and templates) evaluate TOP-LEVEL fields with strict equality
 * (rulesMatch in mca-event-subscription-service, getDotPath in automate-runner),
 * so nested-only payloads cannot be filtered by `conversationId`. This helper
 * projects the nested fields onto flat aliases at dispatch time.
 *
 * Spec: docs/specs/20261018_voice-events.md §3.2 ("Payload anidado") and P2.
 *
 * Compatibility: the original nested shape is preserved untouched — existing
 * templates like {{data.conversation_id}} keep working; the flat aliases are
 * additive. The manifest catalog (mcas/mca.elevenlabs/manifest.json) declares
 * both shapes and mcas/mca.elevenlabs/test/events-payload.test.ts pins them
 * together with POST_CALL_FLAT_FIELDS so they cannot drift.
 *
 * @todo nira - 2026.10.18: v1 candidate — move flattening into the generic
 * webhook handler via a per-MCA "payload projection" config in the manifest,
 * so every nested-provider webhook gets this without per-MCA code.
 */

/** mcaId that owns the post_call_transcription webhook. */
export const ELEVENLABS_MCA_ID = 'mca.elevenlabs';

/** ElevenLabs webhook eventType that carries the post-call transcription. */
export const POST_CALL_EVENT_TYPE = 'post_call_transcription';

/**
 * Nested dot-path → flat alias. Kept in sync with the manifest catalog
 * (mcas/mca.elevenlabs/manifest.json → events[] → payload) and mirrored in
 * mcas/mca.elevenlabs/src/events.ts — the drift tests pin all three.
 */
export const POST_CALL_FLAT_FIELDS: Readonly<Record<string, string>> = {
  'data.conversation_id': 'conversationId',
  'data.agent_id': 'agentId',
  'data.status': 'status',
  'data.analysis.transcript_summary': 'transcriptSummary',
  'data.analysis.call_successful': 'callSuccessful',
  'data.metadata.call_duration_secs': 'durationSecs',
  'data.metadata.termination_reason': 'terminationReason',
  'data.metadata.cost': 'cost',
};

/**
 * True when this mcaId + eventType combination must be flattened.
 */
export function isElevenLabsPostCallEvent(mcaId: string, eventType: string): boolean {
  return mcaId === ELEVENLABS_MCA_ID && eventType === POST_CALL_EVENT_TYPE;
}

/**
 * Read a dot-path value from an object (own properties only).
 * Returns undefined when any segment is missing or not an object.
 */
function getDotValue(obj: Record<string, unknown>, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Return a shallow copy of the payload with the flat aliases added.
 *
 * - An alias is set (overwriting any same-named top-level key) only when the
 *   nested source exists — the nested webhook value is the canonical source.
 * - Missing nested fields are skipped (no alias): templates and filters see
 *   exactly what ElevenLabs sent.
 * - Never mutates the input.
 */
export function flattenElevenLabsPostCallPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const [dotPath, alias] of Object.entries(POST_CALL_FLAT_FIELDS)) {
    const value = getDotValue(payload, dotPath);
    if (value !== undefined) out[alias] = value;
  }
  return out;
}
