/**
 * Flow Event Service
 *
 * Manages event triggers for flows. When a flow with an event trigger is
 * activated, this service stores the trigger configuration. When the
 * MCAEventSubscriptionService dispatches an event, it calls back into this
 * service, which checks for matching flow event triggers and executes
 * the corresponding flows.
 *
 * Lifecycle:
 * - registerEvent: stores the event trigger config when a flow is activated
 * - cancelEvent: removes the event trigger config when a flow is deactivated
 * - onEventDispatched: callback from MCAEventSubscriptionService; executes matching flows
 */

import type { Db, Filter } from 'mongodb';
import { COLLECTIONS, ensureIndexesFor } from '../db';
import type { ActionBridgeManager } from './workflow-action-bridge';
import { captureException } from '../lib/sentry';

/** Collection name for flow event triggers. */
const EVENT_TRIGGERS_COLLECTION = 'flow_event_triggers';

/** Shape of a flow event trigger document in MongoDB. */
export interface FlowEventTrigger {
  /** Unique identifier */
  triggerId: string;
  /** Flow to execute when the event matches */
  flowId: string;
  /** Project board where tasks will be created */
  projectId: string;
  /** User who owns the flow */
  userId: string;
  /** Event topic to match (supports wildcards, e.g. "board.task_*") */
  topic: string;
  /** Optional rules to filter events (OR semantics across objects) */
  rules: Record<string, unknown>[];
  /** When this trigger was registered */
  createdAt: Date;
}

/** Shape of an event dispatched by MCAEventSubscriptionService. */
export interface FlowEventDispatch {
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * FlowEventService
 *
 * Manages the lifecycle of event triggers for flows:
 * - registerEvent: stores the trigger config when a flow is activated
 * - cancelEvent: removes the trigger config when a flow is deactivated
 * - onEventDispatched: callback from MCAEventSubscriptionService; executes matching flows
 */
export class FlowEventService {
  private db: Db;
  private actionBridgeManager: ActionBridgeManager | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  /** Inject the ActionBridgeManager — needed to execute flows. */
  setActionBridgeManager(manager: ActionBridgeManager): void {
    this.actionBridgeManager = manager;
  }

  /**
   * Register (or update) an event trigger for a flow.
   *
   * Stores the event topic and optional rules. When an event matching
   * the topic is dispatched, the flow will be executed.
   *
   * @param flowId     The flow to execute on event
   * @param projectId  The project board where tasks will be created
   * @param userId     User who owns the flow
   * @param topic      Event topic to match (supports wildcards)
   * @param rules      Optional rules to filter events
   */
  async registerEvent(
    flowId: string,
    projectId: string,
    userId: string,
    topic: string,
    rules?: Record<string, unknown>[],
  ): Promise<{ triggerId: string }> {
    const col = this.db.collection(EVENT_TRIGGERS_COLLECTION);

    // Check if a trigger already exists for this flow
    const existing = await col.findOne({ flowId } as Filter<unknown>);

    const triggerId = existing?.triggerId ?? `fet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    if (existing) {
      // Update the existing trigger
      await col.updateOne(
        { flowId } as Filter<unknown>,
        {
          $set: {
            projectId,
            userId,
            topic,
            rules: rules ?? [],
            createdAt: new Date(),
          },
        },
      );
      console.log(`[FlowEventService] Updated event trigger for flow ${flowId}: topic="${topic}"`);
    } else {
      // Create a new trigger
      const trigger: FlowEventTrigger = {
        triggerId,
        flowId,
        projectId,
        userId,
        topic,
        rules: rules ?? [],
        createdAt: new Date(),
      };
      await col.insertOne(trigger as any);
      console.log(`[FlowEventService] Registered event trigger for flow ${flowId}: topic="${topic}"`);
    }

    return { triggerId };
  }

  /**
   * Cancel the event trigger for a flow.
   * Removes the trigger config from MongoDB.
   */
  async cancelEvent(flowId: string): Promise<boolean> {
    const col = this.db.collection(EVENT_TRIGGERS_COLLECTION);
    const result = await col.deleteOne({ flowId } as Filter<unknown>);
    const deleted = result.deletedCount > 0;
    if (deleted) {
      console.log(`[FlowEventService] Cancelled event trigger for flow ${flowId}`);
    }
    return deleted;
  }

  /**
   * Called by MCAEventSubscriptionService when an event is dispatched.
   * Finds all flow event triggers matching the event topic, evaluates
   * optional rules, and executes the matching flows.
   */
  async onEventDispatched(event: FlowEventDispatch): Promise<{ matched: number; executed: number }> {
    if (!this.actionBridgeManager) {
      console.warn('[FlowEventService] ActionBridgeManager not set — cannot execute flows on event');
      return { matched: 0, executed: 0 };
    }

    const col = this.db.collection(EVENT_TRIGGERS_COLLECTION);
    const allTriggers = await col.find({}).toArray() as unknown as FlowEventTrigger[];

    // Filter by topic match (supports wildcards)
    const matching = allTriggers.filter(
      (trigger) => this.topicMatches(trigger.topic, event.topic) && this.rulesMatch(trigger.rules, event.payload),
    );

    if (matching.length === 0) {
      return { matched: 0, executed: 0 };
    }

    console.log(
      `[FlowEventService] Event "${event.topic}" matched ${matching.length} flow trigger(s)`,
    );

    let executed = 0;
    for (const trigger of matching) {
      try {
        const engine = this.actionBridgeManager.getEngine(trigger.projectId);
        const result = await engine.startExecution(trigger.flowId, 'event', {
          topic: event.topic,
          ...event.payload,
        });

        console.log(
          `[FlowEventService] Flow ${trigger.flowId} executed via event trigger. ` +
          `Execution: ${result.execution.executionId}, status: ${result.execution.status}`,
        );
        executed++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[FlowEventService] Failed to execute flow ${trigger.flowId}:`, errorMsg);
        captureException(err, {
          context: 'flow-event-execution',
          flowId: trigger.flowId,
          projectId: trigger.projectId,
          eventTopic: event.topic,
        });
      }
    }

    return { matched: matching.length, executed };
  }

  /**
   * Get all event triggers for a flow (useful for debugging/UI).
   */
  async getTriggersForFlow(flowId: string): Promise<FlowEventTrigger[]> {
    const col = this.db.collection(EVENT_TRIGGERS_COLLECTION);
    return col.find({ flowId } as Filter<unknown>).toArray() as unknown as Promise<FlowEventTrigger[]>;
  }

  // ---------------------------------------------------------------------------
  // INTERNAL HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Check if a topic pattern matches an event topic.
   * Supports wildcards:
   * - "*" matches any topic
   * - "board.*" matches any topic starting with "board."
   * - "board.task_*" matches any topic starting with "board.task_"
   * - Exact match otherwise
   */
  private topicMatches(pattern: string, topic: string): boolean {
    if (pattern === '*') return true;
    if (pattern === topic) return true;

    // Convert glob pattern to regex: * → .*, escape other regex chars
    if (pattern.includes('*')) {
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars except *
        .replace(/\*/g, '.*');                    // * → .*
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(topic);
    }

    return false;
  }

  /**
   * Evaluate rules against a payload.
   * OR semantics across rule objects; AND semantics within each object.
   * Empty rules array → always match.
   */
  private rulesMatch(rules: Record<string, unknown>[], payload: Record<string, unknown>): boolean {
    if (!rules || rules.length === 0) return true;
    return rules.some((ruleObj) =>
      Object.entries(ruleObj).every(([key, value]) => payload[key] === value),
    );
  }

  /** Ensure the event triggers collection has indexes. */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureIndexesFor(this.db, [COLLECTIONS.flowEventTriggers]);
  }
}
