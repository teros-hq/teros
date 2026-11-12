/**
 * MCAEventSubscriptionService
 *
 * High-level service for the MCA event subscription system.
 * Handles:
 *   - CRUD for subscriptions_channel and subscriptions_agent
 *   - Topic matching (including wildcards)
 *   - Event dispatch: inject into channels, wake agents
 *   - Correlation tracking for agent subscriptions
 *
 * This is the "application layer" over PubSubService.
 * PubSubService handles low-level WebSocket fanout and channel-to-channel subscriptions.
 * MCAEventSubscriptionService handles the higher-level MCA event routing.
 */

import type { Db } from 'mongodb';
import {
  type AgentEventSubscription,
  type ChannelEventSubscription,
  type DeclaredEventFilters,
  type Rules,
  type UnifiedFilter,
  generateCorrelationId,
  generateSubscriptionId,
  getAgentEventSubscriptionsCollection,
  getChannelEventSubscriptionsCollection,
  getSubscriptionCorrelationsCollection,
  topicMatches,
  unifiedFilterMatches,
} from '../models/mca-event-subscriptions';
import type { ScheduledEvent } from '../handlers/event-handler';
import type { PubSubService } from './pubsub-service';
/** Events older than this at delivery time are dropped (stale re-sends never wake an agent). */
const SCHEDULER_DISPATCH_TTL_MS = 2 * 60 * 1000;

// ============================================================================
// TYPES
// ============================================================================

export interface MCAEvent {
  topic: string;              // e.g. "channel:turn_end", "gmail.email.received"
  payload: Record<string, unknown>;
}

// Callback to inject an event into a channel and optionally wake the agent
export type EventInjectorFn = (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>;

// Callback to create a new conversation channel
export type CreateChannelFn = (
  userId: string,
  agentId: string,
  metadata?: { name?: string },
) => Promise<{ channelId: string }>;

// Callback to get the userId for an agent (needed when creating channels for agent subscriptions)
export type GetAgentUserIdFn = (agentId: string) => Promise<string | null>;

/**
 * Callback to get the owner userId of a channel. Used as Capa 4 (defense-in-depth)
 * for scheduler events: if the payload includes `userId`, we verify
 * `channel.userId === payload.userId` before injecting the wake-up.
 * Returns null if the channel does not exist.
 */
export type GetChannelOwnerUserIdFn = (channelId: string) => Promise<string | null>;

// Callback to save a message and trigger agent response in a channel
export type InjectTextAndWakeFn = (params: {
  channelId: string;
  text: string;
  senderAgentId?: string;
}) => Promise<void>;

// ============================================================================
// SERVICE
// ============================================================================

export class MCAEventSubscriptionService {
  private eventInjector?: EventInjectorFn;
  private createChannelFn?: CreateChannelFn;
  private getAgentUserIdFn?: GetAgentUserIdFn;
  private getChannelOwnerUserIdFn?: GetChannelOwnerUserIdFn;
  private injectTextAndWakeFn?: InjectTextAndWakeFn;
  private pubSubService?: PubSubService;
  private flowEventCallback?: (event: { topic: string; payload: Record<string, unknown> }) => Promise<{ matched: number; executed: number }>;
  private automateEventCallback?: (event: { topic: string; payload: Record<string, unknown> }) => Promise<{ matched: number; executed: number }>;

  constructor(private db: Db) {}

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Call once at startup. The subscriptions_* indexes are applied by
   * ensureAllIndexes after migrations (src/db/indexes.ts, GOV-4).
   */
  async init(): Promise<void> {
    console.log('[MCAEventSubscriptionService] Initialized');
  }

  setEventInjector(fn: EventInjectorFn): void {
    this.eventInjector = fn;
  }

  setCreateChannelFn(fn: CreateChannelFn): void {
    this.createChannelFn = fn;
  }

  setGetAgentUserIdFn(fn: GetAgentUserIdFn): void {
    this.getAgentUserIdFn = fn;
  }

  /**
   * Inyecta el resolver de owner del channel. Sin esto, la verificación de
   * Capa 4 queda desactivada (warn log). En producción este callback es
   * REQUIRED — el bootstrap lo configura desde el ChannelManager.
   */
  setGetChannelOwnerUserIdFn(fn: GetChannelOwnerUserIdFn): void {
    this.getChannelOwnerUserIdFn = fn;
  }

  setInjectTextAndWakeFn(fn: InjectTextAndWakeFn): void {
    this.injectTextAndWakeFn = fn;
  }

  setPubSubService(service: PubSubService): void {
    this.pubSubService = service;
  }

  /**
   * Inject the FlowEventService callback. When an event is dispatched,
   * this callback is invoked so the FlowEventService can check for matching
   * flow event triggers and execute the corresponding flows.
   */
  setFlowEventCallback(fn: (event: { topic: string; payload: Record<string, unknown> }) => Promise<{ matched: number; executed: number }>): void {
    this.flowEventCallback = fn;
  }

  /** Inject the AutomateRunner callback — fires automate event starters. */
  setAutomateEventCallback(fn: (event: { topic: string; payload: Record<string, unknown> }) => Promise<{ matched: number; executed: number }>): void {
    this.automateEventCallback = fn;
  }

  // ============================================================================
  // CHANNEL SUBSCRIPTIONS CRUD
  // ============================================================================

  async createChannelSubscription(input: {
    topic: string;
    channelId: string;
    rules?: Rules;
    mode: 'notify' | 'wake';
    oneTime?: boolean;
    /** Unified declarative filter (reserved _subscribe tools). */
    filter?: UnifiedFilter;
    /** Snapshot of the app's declared filter semantics for `filter`. */
    filterSpec?: DeclaredEventFilters;
    /** Full topics that wake the agent; absent = all matched events wake. */
    wakeUpOn?: string[];
  }): Promise<ChannelEventSubscription> {
    const col = getChannelEventSubscriptionsCollection(this.db);
    const sub: ChannelEventSubscription = {
      id: generateSubscriptionId(),
      topic: input.topic,
      channelId: input.channelId,
      rules: input.rules ?? [],
      mode: input.mode,
      oneTime: input.oneTime ?? false,
      ...(input.filter && Object.keys(input.filter).length > 0 ? { filter: input.filter } : {}),
      ...(input.filterSpec ? { filterSpec: input.filterSpec } : {}),
      ...(input.wakeUpOn && input.wakeUpOn.length > 0 ? { wakeUpOn: input.wakeUpOn } : {}),
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
    await col.insertOne(sub);
    console.log(`[MCAEventSubscriptionService] Created channel subscription ${sub.id}: topic="${sub.topic}" channelId="${sub.channelId}" mode="${sub.mode}" oneTime=${sub.oneTime}`);
    return sub;
  }

  async deleteChannelSubscription(id: string): Promise<boolean> {
    const col = getChannelEventSubscriptionsCollection(this.db);
    const result = await col.deleteOne({ id });
    return result.deletedCount > 0;
  }

  /**
   * Delete all channel subscriptions matching a topic + channelId pair.
   * Useful for cleanup when a MCA no longer needs to deliver events to a channel.
   */
  async deleteChannelSubscriptionsByTopicAndChannel(topic: string, channelId: string): Promise<number> {
    const col = getChannelEventSubscriptionsCollection(this.db);
    const result = await col.deleteMany({ topic, channelId });
    console.log(`[MCAEventSubscriptionService] Deleted ${result.deletedCount} subscription(s) for topic="${topic}" channelId="${channelId}"`);
    return result.deletedCount;
  }

  async listChannelSubscriptions(channelId: string): Promise<ChannelEventSubscription[]> {
    const col = getChannelEventSubscriptionsCollection(this.db);
    return col.find({ channelId }).toArray();
  }

  /**
   * Create multiple channel subscriptions atomically (batch insert).
   * Used by delegate-task to create the 3 standard subscriptions in one shot.
   */
  async createChannelSubscriptionsBatch(
    inputs: Array<{
      topic: string;
      channelId: string;
      rules?: Rules;
      mode: 'notify' | 'wake';
      oneTime?: boolean;
    }>,
  ): Promise<ChannelEventSubscription[]> {
    const col = getChannelEventSubscriptionsCollection(this.db);
    const subs: ChannelEventSubscription[] = inputs.map((input) => ({
      id: generateSubscriptionId(),
      topic: input.topic,
      channelId: input.channelId,
      rules: input.rules ?? [],
      mode: input.mode,
      oneTime: input.oneTime ?? false,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    }));
    if (subs.length > 0) {
      await col.insertMany(subs);
    }
    console.log(`[MCAEventSubscriptionService] Created ${subs.length} channel subscriptions batch`);
    return subs;
  }

  // ============================================================================
  // AGENT SUBSCRIPTIONS CRUD
  // ============================================================================

  async createAgentSubscription(input: {
    topic: string;
    agentId: string;
    rules?: Rules;
    correlationKey: string;
    oneTime?: boolean;
  }): Promise<AgentEventSubscription> {
    const col = getAgentEventSubscriptionsCollection(this.db);
    const sub: AgentEventSubscription = {
      id: generateSubscriptionId(),
      topic: input.topic,
      agentId: input.agentId,
      rules: input.rules ?? [],
      correlationKey: input.correlationKey,
      oneTime: input.oneTime ?? false,
      createdAt: new Date(),
    };
    await col.insertOne(sub);
    console.log(`[MCAEventSubscriptionService] Created agent subscription ${sub.id}: topic="${sub.topic}" agentId="${sub.agentId}" oneTime=${sub.oneTime}`);
    return sub;
  }

  async deleteAgentSubscription(id: string): Promise<boolean> {
    const col = getAgentEventSubscriptionsCollection(this.db);
    const result = await col.deleteOne({ id });
    return result.deletedCount > 0;
  }

  // ============================================================================
  // EVENT DISPATCH
  // ============================================================================

  /**
   * Dispatch an MCA event to all matching subscriptions.
   * Called when an MCA emits an event (e.g. POST /api/event).
   *
   * 1. Find all channel subscriptions whose topic pattern matches
   * 2. For each: evaluate rules (OR semantics across objects)
   * 3. If match: inject event into channel (notify or wake)
   * 4. Find all agent subscriptions whose topic pattern matches
   * 5. For each: evaluate rules, handle correlation, inject + wake
   */
  async dispatch(event: MCAEvent): Promise<{ channelMatched: number; agentMatched: number }> {
    console.log(`[MCAEventSubscriptionService] Dispatching event: topic="${event.topic}"`);

    // SPECIAL CASE: Terminal Output Streaming
    // These events are volatile and high-frequency. We bypass the subscription DB
    // and broadcast directly to active WebSockets subscribed to the terminal topic.
    if (event.topic === 'terminal_output' && this.pubSubService && event.payload.terminalId) {
      this.pubSubService.broadcastToTopic(`terminal:${event.payload.terminalId}`, {
        type: 'terminal_output',
        data: event.payload.data,
        outputType: event.payload.type,
        terminalId: event.payload.terminalId,
      });
      return { channelMatched: 0, agentMatched: 0 };
    }

    const [channelMatched, agentMatched] = await Promise.all([
      this.dispatchToChannelSubscriptions(event),
      this.dispatchToAgentSubscriptions(event),
    ]);

    // Also notify the FlowEventService so it can execute any flows
    // that have event triggers matching this event topic.
    if (this.flowEventCallback) {
      try {
        await this.flowEventCallback({ topic: event.topic, payload: event.payload });
      } catch (err) {
        console.error('[MCAEventSubscriptionService] Error in flowEventCallback:', err);
      }
    }

    // Also notify the AutomateRunner so starters with event triggers fire.
    if (this.automateEventCallback) {
      try {
        await this.automateEventCallback({ topic: event.topic, payload: event.payload });
      } catch (err) {
        console.error('[MCAEventSubscriptionService] Error in automateEventCallback:', err);
      }
    }

    return { channelMatched, agentMatched };
  }

  // ============================================================================
  // CHANNEL SUBSCRIPTION DISPATCH
  // ============================================================================

  private async dispatchToChannelSubscriptions(event: MCAEvent): Promise<number> {
    if (!this.eventInjector) {
      console.warn('[MCAEventSubscriptionService] No eventInjector set — cannot dispatch to channels');
      return 0;
    }

    const col = getChannelEventSubscriptionsCollection(this.db);
    // Load all channel subscriptions — we filter by topic in memory to support wildcards
    // For production with many subscriptions, add a topic prefix index and pre-filter
    const allSubs = await col.find({}).toArray();

    const matching = allSubs.filter(
      (sub) =>
        topicMatches(sub.topic, event.topic) &&
        this.rulesMatch(sub.rules, event.payload) &&
        unifiedFilterMatches(sub.filter, sub.filterSpec, event.payload),
    );

    if (matching.length === 0) {
      console.log(`[MCAEventSubscriptionService] No channel subscriptions matched topic="${event.topic}"`);
      return 0;
    }

    console.log(`[MCAEventSubscriptionService] ${matching.length} channel subscription(s) matched topic="${event.topic}"`);

    // One-time subscriptions: atomically claim-and-delete BEFORE delivery.
    // deleteOne({id, oneTime:true}) is the claim — if two events race for the
    // same one-time sub, only the first delete wins (deletedCount=1); the second
    // gets deletedCount=0 and must NOT deliver. This makes one-time delivery
    // idempotent-by-design without locks.
    const oneTimeSubs = matching.filter((sub) => sub.oneTime === true);
    const ongoingSubs = matching.filter((sub) => sub.oneTime !== true);
    const claimedOneTimeSubs: ChannelEventSubscription[] = [];
    await Promise.all(
      oneTimeSubs.map(async (sub) => {
        try {
          const result = await col.deleteOne({ id: sub.id, oneTime: true });
          if (result.deletedCount === 1) {
            claimedOneTimeSubs.push(sub);
            console.log(`[MCAEventSubscriptionService] One-time channel subscription ${sub.id} claimed and deleted (topic="${event.topic}")`);
          }
        } catch (err) {
          console.error(`[MCAEventSubscriptionService] Error deleting one-time channel subscription ${sub.id}:`, err);
        }
      }),
    );

    // Effective set of subscriptions that will receive this event:
    // ongoing subs always deliver; one-time subs only if we won the claim.
    const deliverable = [...ongoingSubs, ...claimedOneTimeSubs];
    if (deliverable.length === 0) {
      console.log(`[MCAEventSubscriptionService] All matched channel subscriptions were one-time already claimed by a concurrent event (topic="${event.topic}")`);
      return 0;
    }

    // Sliding TTL: update lastActivityAt for matched ONGOING subscriptions so MongoDB
    // does not expire them while they are still actively receiving events.
    // (One-time subs are already deleted — no TTL bump needed.)
    const ongoingIds = ongoingSubs.map((sub) => sub.id);
    if (ongoingIds.length > 0) {
      await col.updateMany(
        { id: { $in: ongoingIds } },
        { $set: { lastActivityAt: new Date() } },
      );
    }

    // Group matching subscriptions by target channelId.
    // For each target channel, collapse all matching subscriptions into a single
    // effective mode: wake > notify (highest priority wins).
    // This ensures that if a channel has both a wildcard notify and a specific wake
    // subscription for the same event, only ONE injection happens — with mode=wake.
    const byChannel = new Map<string, 'notify' | 'wake'>();
    for (const sub of deliverable) {
      // wakeUpOn (unified subscriptions): a listed topic wakes, anything else
      // delivers as notify only. Absent list = the subscription's own mode.
      const wakes =
        sub.mode === 'wake' &&
        (!sub.wakeUpOn || sub.wakeUpOn.length === 0 || sub.wakeUpOn.includes(event.topic));
      const effective: 'notify' | 'wake' = wakes ? 'wake' : 'notify';
      const current = byChannel.get(sub.channelId);
      if (!current || effective === 'wake') {
        byChannel.set(sub.channelId, effective);
      }
    }

    await Promise.all(
      Array.from(byChannel.entries()).map(async ([channelId, effectiveMode]) => {
        try {
          // -- Capa 4 (TER-358): defense-in-depth ownership check --
          // Si el payload del evento incluye `userId`, verificar que el
          // channel destino pertenece a ese user antes de inyectar. Esto
          // cubre el caso donde el MCA scheduler (Capa 1), callback-routes
          // (Capa 2) o el executor (Capa 3) fallan. Sin owner resoluble,
          // abort. Cualquier MCA puede opt-in a esta verificación incluyendo
          // `userId` en el payload del dispatch.
          const expectedUserId =
            typeof event.payload.userId === 'string' ? event.payload.userId : undefined;
          if (expectedUserId) {
            if (!this.getChannelOwnerUserIdFn) {
              console.warn(
                `[MCAEventSubscriptionService] Capa 4 ownership check skipped (no resolver) for topic="${event.topic}" channel=${channelId}. Configure setGetChannelOwnerUserIdFn in bootstrap.`,
              );
            } else {
              const ownerUserId = await this.getChannelOwnerUserIdFn(channelId);
              if (ownerUserId !== expectedUserId) {
                console.error(
                  `[MCAEventSubscriptionService] Capa 4 ownership mismatch on topic="${event.topic}": channel ${channelId} owner=${ownerUserId} expected=${expectedUserId}. Aborting wake-up.`,
                );
                return; // abort este subscriber; el resto siguen
              }
            }
          }

          // incident-2026-08-14: TTL freshness check for scheduler payloads.
          // If the payload includes `dispatchedAt`, reject events older than
          // SCHEDULER_DISPATCH_TTL_MS. This prevents re-envíos caducados
          // (retry after subscription re-create, stale queue, etc.) from
          // waking the agent with a message that is no longer relevant.
          const dispatchedAt =
            typeof event.payload.dispatchedAt === 'number'
              ? event.payload.dispatchedAt
              : undefined;
          if (dispatchedAt !== undefined) {
            const ageMs = Date.now() - dispatchedAt;
            if (ageMs > SCHEDULER_DISPATCH_TTL_MS) {
              console.warn(
                `[MCAEventSubscriptionService] Discarding stale event topic="${event.topic}" channel=${channelId}: payload age ${ageMs}ms exceeds TTL ${SCHEDULER_DISPATCH_TTL_MS}ms`,
              );
              return;
            }
          }

          // Special case: channel:turn_end with mode=wake and a lastText payload.
          // Instead of injecting a system event, inject the sub-agent's text directly
          // so the parent agent sees it as a user message and responds to it.
          if (
            effectiveMode === 'wake' &&
            topicMatches('channel:turn_end', event.topic) &&
            typeof event.payload.lastText === 'string' &&
            event.payload.lastText.trim() &&
            this.injectTextAndWakeFn
          ) {
            await this.injectTextAndWakeFn({
              channelId,
              text: event.payload.lastText as string,
              senderAgentId: event.payload.agentId as string | undefined,
            });
            console.log(`[MCAEventSubscriptionService] Injected turn_end text into channel ${channelId} (wake)`);
            return;
          }

          // General case: inject as a system event
          const scheduledEvent: ScheduledEvent = {
            channelId,
            message: this.buildEventMessage(event),
            eventType: this.mapTopicToEventType(event.topic),
            wakeUpAgent: effectiveMode === 'wake',
            metadata: {
              source: 'mca_event_subscription',
              ...event.payload,
            } as any,
          };
          await this.eventInjector!(scheduledEvent);
          console.log(`[MCAEventSubscriptionService] Dispatched to channel ${channelId} (effectiveMode=${effectiveMode})`);
        } catch (err) {
          console.error(`[MCAEventSubscriptionService] Error dispatching to channel ${channelId}:`, err);
        }
      }),
    );
    return byChannel.size;
  }

  // ============================================================================
  // AGENT SUBSCRIPTION DISPATCH
  // ============================================================================

  private async dispatchToAgentSubscriptions(event: MCAEvent): Promise<number> {
    if (!this.eventInjector || !this.createChannelFn || !this.getAgentUserIdFn) {
      return 0;
    }

    const col = getAgentEventSubscriptionsCollection(this.db);
    const allSubs = await col.find({}).toArray();

    const matching = allSubs.filter(
      (sub) => topicMatches(sub.topic, event.topic) && this.rulesMatch(sub.rules, event.payload),
    );

    if (matching.length === 0) return 0;

    // incident-2026-08-14: TTL freshness check — reject stale payloads early
    // before creating/reusing channels or waking agents.
    const dispatchedAt =
      typeof event.payload.dispatchedAt === 'number'
        ? event.payload.dispatchedAt
        : undefined;
    if (dispatchedAt !== undefined) {
      const ageMs = Date.now() - dispatchedAt;
      if (ageMs > SCHEDULER_DISPATCH_TTL_MS) {
        console.warn(
          `[MCAEventSubscriptionService] Discarding stale agent event topic="${event.topic}": payload age ${ageMs}ms exceeds TTL ${SCHEDULER_DISPATCH_TTL_MS}ms`,
        );
        return 0;
      }
    }

    const corrCol = getSubscriptionCorrelationsCollection(this.db);

    // One-time subscriptions: atomically claim-and-delete BEFORE delivery.
    // Same race-safe semantics as channel subscriptions: only the dispatch that
    // wins the deleteOne delivers the event.
    const oneTimeAgentSubs = matching.filter((sub) => sub.oneTime === true);
    const ongoingAgentSubs = matching.filter((sub) => sub.oneTime !== true);
    const claimedAgentSubs: AgentEventSubscription[] = [];
    await Promise.all(
      oneTimeAgentSubs.map(async (sub) => {
        try {
          const result = await col.deleteOne({ id: sub.id, oneTime: true });
          if (result.deletedCount === 1) {
            claimedAgentSubs.push(sub);
            console.log(`[MCAEventSubscriptionService] One-time agent subscription ${sub.id} claimed and deleted (topic="${event.topic}")`);
          }
        } catch (err) {
          console.error(`[MCAEventSubscriptionService] Error deleting one-time agent subscription ${sub.id}:`, err);
        }
      }),
    );

    const deliverableAgentSubs = [...ongoingAgentSubs, ...claimedAgentSubs];
    if (deliverableAgentSubs.length === 0) return 0;

    await Promise.all(
      deliverableAgentSubs.map(async (sub) => {
        try {
          const correlationValue = String(event.payload[sub.correlationKey] ?? '');
          let channelId: string;

          // Look up existing correlation
          const existing = await corrCol.findOne({
            subscriptionId: sub.id,
            correlationValue,
          });

          if (existing) {
            channelId = existing.channelId;
            console.log(`[MCAEventSubscriptionService] Reusing channel ${channelId} for agent ${sub.agentId} (correlation=${correlationValue})`);
          } else {
            // Create new conversation
            const userId = await this.getAgentUserIdFn!(sub.agentId);
            if (!userId) {
              console.error(`[MCAEventSubscriptionService] Cannot find userId for agent ${sub.agentId}`);
              return;
            }
            const newChannel = await this.channelManagerCreateChannel(userId, sub.agentId, {
              name: `Event: ${event.topic}`,
            });
            channelId = newChannel.channelId;

            // Store correlation
            await corrCol.insertOne({
              id: generateCorrelationId(),
              subscriptionId: sub.id,
              correlationValue,
              channelId,
              createdAt: new Date(),
            });
            console.log(`[MCAEventSubscriptionService] Created channel ${channelId} for agent ${sub.agentId} (correlation=${correlationValue})`);
          }

          // Inject event and wake agent
          const scheduledEvent: ScheduledEvent = {
            channelId,
            message: this.buildEventMessage(event),
            eventType: this.mapTopicToEventType(event.topic),
            wakeUpAgent: true, // agent subscriptions always wake
            metadata: {
              source: 'mca_event_subscription',
              ...event.payload,
            } as any,
          };
          await this.eventInjector!(scheduledEvent);
        } catch (err) {
          console.error(`[MCAEventSubscriptionService] Error dispatching to agent ${sub.agentId}:`, err);
        }
      }),
    );
    return matching.length;
  }

  // Mock call for channelManager logic above
  private async channelManagerCreateChannel(userId: string, agentId: string, metadata: any) {
    return this.createChannelFn!(userId, agentId, metadata);
  }

  // ============================================================================
  // RULE EVALUATION
  // ============================================================================

  /**
   * Evaluate rules against a payload.
   * Framework contract: rules array is OR — any matching object passes.
   * Empty rules array → always match.
   *
   * The semantics of multiple fields within an object are MCA-defined (typically AND).
   * Here we implement simple equality checks as the default — MCAs with complex
   * semantics must implement their own rule evaluation endpoint.
   */
  private rulesMatch(rules: Rules, payload: Record<string, unknown>): boolean {
    if (rules.length === 0) return true;

    // OR across rule objects
    return rules.some((ruleObj) => this.ruleObjectMatches(ruleObj, payload));
  }

  /**
   * Check if a single rule object matches the payload.
   * Default: all fields in the object must match (AND semantics).
   * Each field is compared by strict equality.
   */
  private ruleObjectMatches(ruleObj: Record<string, unknown>, payload: Record<string, unknown>): boolean {
    return Object.entries(ruleObj).every(([key, value]) => payload[key] === value);
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private buildEventMessage(event: MCAEvent): string {
    const p = event.payload as any;
    if (event.topic === 'channel:turn_start') {
      return `${p.channelName || p.channelId} started`;
    }
    if (event.topic === 'channel:turn_end') {
      return `${p.channelName || p.channelId} finished`;
    }
    if (event.topic === 'scheduler.reminder') {
      return p.message || 'Reminder';
    }
    if (event.topic === 'scheduler.recurring_task') {
      return p.message || 'Recurring task';
    }
    if (event.topic === 'elevenlabs.post_call_transcription') {
      // Flat aliases come from flattenElevenLabsPostCallPayload (webhook
      // handler). Build a readable one-liner instead of a JSON dump — this is
      // what the user sees in the channel and what the woken agent reads
      // (spec 20261018_voice-events.md §3.3). No IDs in the message
      // (product rule: users never see raw IDs).
      const summary =
        typeof p.transcriptSummary === 'string' ? p.transcriptSummary.trim() : '';
      const dur =
        typeof p.durationSecs === 'number' ? `${Math.round(p.durationSecs)}s` : undefined;
      const ok = p.callSuccessful === true;
      const reason =
        !ok && typeof p.terminationReason === 'string' ? p.terminationReason : undefined;
      const facts = [
        ok ? 'call successful' : `call unsuccessful${reason ? ` — ${reason}` : ''}`,
        dur,
      ]
        .filter(Boolean)
        .join(', ');
      if (summary) return `${summary} (${facts})`;
      return `Call ${ok ? 'finished successfully' : `ended unsuccessfully${reason ? ` — ${reason}` : ''}`}${dur ? ` (${dur})` : ''}`;
    }
    return `[${event.topic}] ${JSON.stringify(event.payload)}`;
  }

  /**
   * Map a topic string to the closest EventHandler eventType.
   * channel:* topics map to their specific type; others map to 'task_update' as a generic.
   */
  private mapTopicToEventType(topic: string): ScheduledEvent['eventType'] {
    if (topic === 'channel:turn_start') return 'channel_started';
    if (topic === 'channel:turn_end') return 'channel_finished';
    if (topic === 'channel:permission_request') return 'channel_permission';
    if (topic === 'channel:permission_granted') return 'channel_resolved';
    if (topic === 'channel:permission_denied') return 'channel_resolved';
    if (topic === 'reminder') return 'reminder';
    if (topic === 'recurring_task') return 'recurring_task';
    if (topic === 'scheduler.reminder') return 'reminder';
    if (topic === 'scheduler.recurring_task') return 'recurring_task';
    if (topic === 'elevenlabs.post_call_transcription') return 'voice.post_call';
    return 'task_update'; // generic fallback for MCA events
  }
}
