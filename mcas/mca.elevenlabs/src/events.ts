/**
 * Event emission for mca.elevenlabs.
 *
 * The manifest (`manifest.json` → events[]) is the catalog agents and Automate
 * use to write filters and templates. This module builds the actual payloads
 * sent to the bus; `test/events-payload.test.ts` pins the two together so they
 * can never drift apart.
 */

/** Topics emitted by this MCA. Conversations/boards/Automate subscribe to these. */
export const ELEVENLABS_EVENT_TOPICS = [
  'elevenlabs.post_call_transcription',
  'elevenlabs.call.started',
] as const;

export interface CallStartedPayload {
  conversationId: string | null;
  callSid: string | null;
  toNumber: string;
  agentId: string;
  phoneNumberId: string;
  initiatorChannelId: string | null;
  initiatorAgentId: string | null;
  occurredAt: string;
}

/**
 * Build the catalog-shaped payload for `elevenlabs.call.started`.
 * Emitted locally by the `outbound-call` tool right after ElevenLabs accepts
 * the dispatch — not to be confused with `post_call_transcription`, which
 * arrives later via the signed webhook.
 */
export function buildCallStartedPayload(args: {
  conversationId: string | null;
  callSid: string | null;
  toNumber: string;
  agentId: string;
  phoneNumberId: string;
  initiatorChannelId: string | null;
  initiatorAgentId: string | null;
}): CallStartedPayload {
  return {
    conversationId: args.conversationId,
    callSid: args.callSid,
    toNumber: args.toNumber,
    agentId: args.agentId,
    phoneNumberId: args.phoneNumberId,
    initiatorChannelId: args.initiatorChannelId,
    initiatorAgentId: args.initiatorAgentId,
    occurredAt: new Date().toISOString(),
  };
}
