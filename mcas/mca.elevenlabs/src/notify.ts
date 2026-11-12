/**
 * Auto-subscribe of the initiator channel to the post-call event.
 *
 * Spec: docs/specs/20261018_voice-events.md §3.3 (subscribe-by-default) and
 * §3.5 (programmatic subscription creation). When outbound-call fires with
 * notifyChannel (default true) and the call was launched from a Teros channel,
 * we create a ONE-TIME channel subscription — topic
 * elevenlabs.post_call_transcription, filter { conversationId: <this call> } —
 * so the initiating channel receives exactly one post-call notification and
 * the subscription cleans itself up after delivery (backend P1).
 *
 * The subscription is created through the MCA backend callback
 * (POST /subscriptions/channel via the SDK's createChannelSubscription), which
 * enforces channel-ownership authorization (Capa 2, TER-358) before writing.
 *
 * Best-effort by design: a subscription failure must NEVER fail the call —
 * the call is already placed; the user would just miss the notification.
 */

/** Topic the post-call webhook dispatches to (mirrors the manifest catalog). */
export const POST_CALL_TOPIC = 'elevenlabs.post_call_transcription';

/**
 * Filter rules for a per-call one-time subscription.
 * rulesMatch evaluates top-level equality — the backend flattens the nested
 * post_call payload (conversationId at top level) before dispatching.
 */
export function buildPostCallSubscriptionRules(conversationId: string): Array<Record<string, unknown>> {
  return [{ conversationId }];
}

/** Outcome of the best-effort auto-subscribe (surfaced in the tool result). */
export interface NotifyChannelOutcome {
  /** true when the one-time subscription was created. */
  subscribed: boolean;
  /** Why not, when subscribed is false. */
  reason?:
    | 'notifyChannel_disabled'
    | 'no_initiator_channel'
    | 'no_conversation_id'
    | 'backend_unavailable'
    | 'subscription_error';
  subscriptionId?: string;
  errorMessage?: string;
}

/**
 * Create the one-time post-call subscription for the initiating channel.
 *
 * @param params.backend        SDK backend client from the tool context (may be undefined)
 * @param params.notifyChannel  the tool's notifyChannel argument (default true)
 * @param params.conversationId ElevenLabs conversation id of THIS call
 * @param params.initiatorChannelId Teros channel that launched the call (may be null: inbound/API)
 */
export async function subscribeInitiatorChannelToPostCall(params: {
  backend?: any;
  notifyChannel?: boolean;
  conversationId: string | null | undefined;
  initiatorChannelId: string | null | undefined;
}): Promise<NotifyChannelOutcome> {
  // Fire-and-forget opt-out (spec §3.3): no subscription at all.
  if (params.notifyChannel === false) {
    return { subscribed: false, reason: 'notifyChannel_disabled' };
  }
  // Calls launched outside a Teros channel (inbound, API) have no initiator:
  // nothing to notify — explicit Automate starters cover that case (§3.3).
  if (!params.initiatorChannelId) {
    return { subscribed: false, reason: 'no_initiator_channel' };
  }
  // Without a conversation id we cannot scope the filter; a wildcard one-time
  // subscription would swallow the next post-call event of ANY call.
  if (!params.conversationId) {
    return { subscribed: false, reason: 'no_conversation_id' };
  }
  const backend = params.backend;
  if (!backend || typeof backend.createChannelSubscription !== 'function') {
    return { subscribed: false, reason: 'backend_unavailable' };
  }

  try {
    const res = await backend.createChannelSubscription({
      topic: POST_CALL_TOPIC,
      // Wake (not notify): the post-call event must WAKE the channel's agent so
      // it reports the outcome to the user in natural language (spec §3.3 —
      // "El usuario ve 'Llamada a Lilibeth terminada: van el miercoles 21 a Oviedo'").
      // Notify mode only injects a system event nobody answers.
      mode: 'wake',
      rules: buildPostCallSubscriptionRules(params.conversationId),
      channelId: params.initiatorChannelId,
      oneTime: true,
    });
    const subId = res?.subscription?.id;
    if (!res?.success || !subId) {
      console.error('[mca.elevenlabs] Post-call subscription rejected by backend:', JSON.stringify(res));
      return { subscribed: false, reason: 'subscription_error', errorMessage: JSON.stringify(res) };
    }
    console.log(`[mca.elevenlabs] One-time post-call subscription ${subId} created for channel ${params.initiatorChannelId} (conversation ${params.conversationId})`);
    return { subscribed: true, subscriptionId: subId };
  } catch (err) {
    // Best-effort: log and continue — the call itself must not fail.
    console.error('[mca.elevenlabs] Failed to create post-call subscription:', (err as Error).message);
    return { subscribed: false, reason: 'subscription_error', errorMessage: (err as Error).message };
  }
}
