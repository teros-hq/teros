/**
 * Flow Webhook Handler (WS)
 *
 * WS handler for managing webhook triggers on flows.
 * Called by the workflows MCA after a flow is saved/activated.
 *
 * Actions:
 *   flow.register-webhook  → Generate a token and store it in the flow's trigger config
 *   flow.cancel-webhook     → Remove the token from the flow's trigger config
 *   flow.get-webhook-url    → Get the webhook URL for a flow (if it has a webhook trigger)
 */

import { HandlerError } from '../../../ws-framework/WsRouter';
import type { WsHandlerContext } from '@teros/shared';
import { z } from 'zod';
import type { Db } from 'mongodb';
import { requireFlowAccess, requireFlowProject } from './_flow-access';
import type { FlowWebhookService } from '../../../services/flow-webhook-service';

// ---------------------------------------------------------------------------
// flow.register-webhook
// ---------------------------------------------------------------------------

const RegisterWebhookSchema = z.object({
  flowId: z.string().min(1),
  projectId: z.string().min(1),
  secret: z.string().optional(),
});

export function createRegisterWebhookHandler(flowWebhookService: FlowWebhookService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const userId = ctx.userId;
    if (!userId || userId.trim() === '') {
      throw new HandlerError('NO_USER_CONTEXT', 'WsHandlerContext.userId missing');
    }

    const parsed = RegisterWebhookSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    const input = parsed.data;
    const workspaceId = await requireFlowAccess(db, userId, input.flowId, 'write');
    await requireFlowProject(db, workspaceId, input.projectId);

    const result = await flowWebhookService.registerWebhook(
      input.flowId,
      input.projectId,
      userId,
      input.secret,
    );

    return {
      action: 'registered' as const,
      flowId: input.flowId,
      token: result.token,
      webhookPath: result.webhookPath,
    };
  };
}

// ---------------------------------------------------------------------------
// flow.cancel-webhook
// ---------------------------------------------------------------------------

const CancelWebhookSchema = z.object({
  flowId: z.string().min(1),
});

export function createCancelWebhookHandler(flowWebhookService: FlowWebhookService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const userId = ctx.userId;
    if (!userId || userId.trim() === '') {
      throw new HandlerError('NO_USER_CONTEXT', 'WsHandlerContext.userId missing');
    }

    const parsed = CancelWebhookSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    await requireFlowAccess(db, userId, parsed.data.flowId, 'write');
    const cancelled = await flowWebhookService.cancelWebhook(parsed.data.flowId);

    return {
      action: cancelled ? ('cancelled' as const) : ('noop' as const),
      flowId: parsed.data.flowId,
    };
  };
}

// ---------------------------------------------------------------------------
// flow.get-webhook-url
// ---------------------------------------------------------------------------

const GetWebhookUrlSchema = z.object({
  flowId: z.string().min(1),
});

export function createGetWebhookUrlHandler(flowWebhookService: FlowWebhookService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const parsed = GetWebhookUrlSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    // The path carries the token that runs the flow: as sensitive as rotating it
    await requireFlowAccess(db, ctx.userId, parsed.data.flowId, 'write');
    const webhookPath = await flowWebhookService.getWebhookUrl(parsed.data.flowId);

    return {
      flowId: parsed.data.flowId,
      webhookPath: webhookPath ?? null,
      hasWebhook: webhookPath !== null,
    };
  };
}
