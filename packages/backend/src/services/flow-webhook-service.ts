/**
 * Flow Webhook Service
 *
 * Manages webhook triggers for flows. When a flow with a webhook trigger is
 * activated, this service generates a unique token and stores it in the flow's
 * trigger config. The webhook URL is:
 *   POST /webhooks/flow/<token>
 *
 * When an external system sends a POST to that URL, the FlowWebhookHandler
 * calls this service to execute the flow with the payload as triggerData.
 *
 * Security:
 * - The URL contains a unique token (32 hex chars), not the flowId
 * - The token is validated on every request
 * - Invocations are logged to the flow_webhook_invocations collection
 * - Optional secret/token for additional authentication
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { COLLECTIONS, ensureIndexesFor } from '../db';
import type { Db, Filter } from 'mongodb';
import type { ActionBridgeManager } from './workflow-action-bridge';
import { captureException } from '../lib/sentry';

/** Length of the random token in bytes (32 bytes = 64 hex chars). */
const TOKEN_BYTES = 32;

/** Collection name for webhook invocation logs. */
const INVOCATIONS_COLLECTION = 'flow_webhook_invocations';

/** Maximum body size for webhook payloads (1 MB). */
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * FlowWebhookService
 *
 * Manages the lifecycle of webhook triggers for flows:
 * - registerWebhook: generates a token and stores it in the flow's trigger config
 * - cancelWebhook: removes the token from the flow's trigger config
 * - handleWebhook: validates the token, executes the flow with the payload
 */
export class FlowWebhookService {
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
   * Register a webhook trigger for a flow.
   * Generates a unique token and stores it in the flow's webhook trigger config.
   *
   * @param flowId     The flow to register the webhook for
   * @param projectId  The project board where tasks will be created
   * @param userId     User who owns the flow
   * @param secret     Optional secret for additional authentication
   * @returns The generated token and the full webhook URL path
   */
  async registerWebhook(
    flowId: string,
    projectId: string,
    userId: string,
    secret?: string,
  ): Promise<{ token: string; webhookPath: string }> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const webhookPath = `/webhooks/flow/${token}`;

    // Store the token in the flow's webhook trigger config
    const flowsCol = this.db.collection('flows');
    const flow = await flowsCol.findOne({ flowId } as Filter<unknown>);

    if (!flow) {
      throw new Error(`Flow not found: ${flowId}`);
    }

    // Update the webhook trigger's config with the token
    const triggers = (flow.triggers ?? []) as Array<{
      triggerId: string;
      type: string;
      config: Record<string, unknown>;
    }>;

    const updatedTriggers = triggers.map((t) => {
      if (t.type === 'webhook') {
        return {
          ...t,
          config: {
            ...t.config,
            webhookToken: token,
            secret: secret ?? t.config.secret,
          },
        };
      }
      return t;
    });

    await flowsCol.updateOne(
      { flowId } as Filter<unknown>,
      {
        $set: {
          triggers: updatedTriggers,
          updatedAt: new Date(),
        },
      },
    );

    console.log(`[FlowWebhookService] Registered webhook for flow ${flowId}, token: ${token.slice(0, 8)}...`);

    return { token, webhookPath };
  }

  /**
   * Cancel the webhook trigger for a flow.
   * Removes the token from the flow's webhook trigger config.
   */
  async cancelWebhook(flowId: string): Promise<boolean> {
    const flowsCol = this.db.collection('flows');
    const flow = await flowsCol.findOne({ flowId } as Filter<unknown>);

    if (!flow) {
      return false;
    }

    const triggers = (flow.triggers ?? []) as Array<{
      triggerId: string;
      type: string;
      config: Record<string, unknown>;
    }>;

    const updatedTriggers = triggers.map((t) => {
      if (t.type === 'webhook') {
        return {
          ...t,
          config: {
            ...t.config,
            webhookToken: undefined,
          },
        };
      }
      return t;
    });

    await flowsCol.updateOne(
      { flowId } as Filter<unknown>,
      {
        $set: {
          triggers: updatedTriggers,
          updatedAt: new Date(),
        },
      },
    );

    console.log(`[FlowWebhookService] Cancelled webhook for flow ${flowId}`);
    return true;
  }

  /**
   * Handle an incoming webhook request.
   * Validates the token, loads the flow, and executes it with the payload.
   *
   * @param token    The webhook token from the URL
   * @param payload  The parsed JSON body from the request
   * @param headers  Request headers (for optional secret verification)
   * @returns Result with execution ID or error
   */
  async handleWebhook(
    token: string,
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ success: boolean; executionId?: string; error?: string; statusCode: number }> {
    // 1. Find the flow by webhook token
    const flowsCol = this.db.collection('flows');
    const flow = await flowsCol.findOne({
      'triggers': {
        $elemMatch: {
          type: 'webhook',
          'config.webhookToken': token,
        },
      },
    });

    if (!flow) {
      return { success: false, statusCode: 404, error: 'Webhook not found' };
    }

    const flowId = flow.flowId as string;
    const flowStatus = flow.status as string;

    // 2. Check flow is active
    if (flowStatus !== 'active') {
      await this.logInvocation(flowId, token, 'rejected', 'Flow is not active');
      return { success: false, statusCode: 403, error: 'Flow is not active' };
    }

    // 3. Find the webhook trigger and check for secret
    const triggers = (flow.triggers ?? []) as Array<{
      triggerId: string;
      type: string;
      config: Record<string, unknown>;
    }>;

    const webhookTrigger = triggers.find((t) => t.type === 'webhook');
    if (!webhookTrigger) {
      return { success: false, statusCode: 404, error: 'Webhook trigger not found' };
    }

    // 4. Verify secret if configured
    const configuredSecret = webhookTrigger.config.secret as string | undefined;
    if (configuredSecret) {
      const providedSecret =
        this.getHeader(headers, 'x-webhook-secret') ??
        this.getHeader(headers, 'authorization')?.replace(/^Bearer\s+/i, '');

      if (!providedSecret) {
        await this.logInvocation(flowId, token, 'rejected', 'Missing secret');
        return { success: false, statusCode: 401, error: 'Missing authentication secret' };
      }

      if (!this.verifySecret(providedSecret, configuredSecret)) {
        await this.logInvocation(flowId, token, 'rejected', 'Invalid secret');
        return { success: false, statusCode: 401, error: 'Invalid secret' };
      }
    }

    // 5. Get the project ID for execution
    const projectId = (flow.projectId as string | undefined) ??
      (webhookTrigger.config.projectId as string | undefined) ??
      '';

    if (!projectId) {
      await this.logInvocation(flowId, token, 'error', 'No project ID configured');
      return { success: false, statusCode: 500, error: 'Flow has no project configured' };
    }

    // 6. Execute the flow
    if (!this.actionBridgeManager) {
      const error = 'ActionBridgeManager not set — cannot execute flow';
      console.error(`[FlowWebhookService] ${error}`);
      await this.logInvocation(flowId, token, 'error', error);
      return { success: false, statusCode: 500, error };
    }

    try {
      const engine = this.actionBridgeManager.getEngine(projectId);
      const result = await engine.startExecution(flowId, 'webhook', payload);

      console.log(
        `[FlowWebhookService] Flow ${flowId} executed via webhook trigger. ` +
        `Execution: ${result.execution.executionId}, status: ${result.execution.status}`,
      );

      await this.logInvocation(flowId, token, 'success', undefined, result.execution.executionId);

      return {
        success: true,
        executionId: result.execution.executionId,
        statusCode: 200,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[FlowWebhookService] Failed to execute flow ${flowId}:`, errorMsg);
      await this.logInvocation(flowId, token, 'error', errorMsg);
      captureException(err, {
        context: 'flow-webhook-execution',
        flowId,
        projectId,
      });
      return { success: false, statusCode: 500, error: errorMsg };
    }
  }

  /**
   * Get the webhook URL for a flow (if it has a webhook trigger with a token).
   */
  async getWebhookUrl(flowId: string): Promise<string | null> {
    const flowsCol = this.db.collection('flows');
    const flow = await flowsCol.findOne({ flowId } as Filter<unknown>);

    if (!flow) return null;

    const triggers = (flow.triggers ?? []) as Array<{
      type: string;
      config: Record<string, unknown>;
    }>;

    const webhookTrigger = triggers.find((t) => t.type === 'webhook');
    if (!webhookTrigger) return null;

    const token = webhookTrigger.config.webhookToken as string | undefined;
    if (!token) return null;

    return `/webhooks/flow/${token}`;
  }

  // ---------------------------------------------------------------------------
  // INTERNAL HELPERS
  // ---------------------------------------------------------------------------

  /** Log a webhook invocation to the database. */
  private async logInvocation(
    flowId: string,
    token: string,
    status: 'success' | 'rejected' | 'error',
    error?: string,
    executionId?: string,
  ): Promise<void> {
    try {
      await this.db.collection(INVOCATIONS_COLLECTION).insertOne({
        flowId,
        tokenHash: token.slice(0, 8), // Store only first 8 chars for debugging
        status,
        error,
        executionId,
        timestamp: new Date(),
      });
    } catch (logErr) {
      // Logging is best-effort — don't fail the webhook if logging fails
      console.error('[FlowWebhookService] Failed to log invocation:', logErr);
    }
  }

  /** Constant-time secret comparison. */
  private verifySecret(provided: string, expected: string): boolean {
    try {
      const providedBuf = Buffer.from(provided, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (providedBuf.length !== expectedBuf.length) {
        return false;
      }
      return timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /** Get a header value, handling array and case variations. */
  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  }

  /** Ensure the invocations collection has indexes. */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureIndexesFor(this.db, [COLLECTIONS.flowWebhookInvocations]);
    // TTL index on timestamp removed (2026-09-23): webhook invocations are
    // evidence of what triggered a flow and never expire per product decision.
  }
}
