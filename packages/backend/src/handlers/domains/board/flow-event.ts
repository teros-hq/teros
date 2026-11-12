/**
 * Flow Event Handler (WS)
 *
 * WS handler for managing event triggers on flows.
 * Called by the workflows MCA after a flow is saved/activated.
 *
 * Actions:
 *   flow.register-event  → Register an event trigger for a flow
 *   flow.cancel-event     → Remove the event trigger for a flow
 *   flow.list-event-triggers → List event triggers for a flow
 */

import { HandlerError } from '../../../ws-framework/WsRouter';
import type { WsHandlerContext } from '@teros/shared';
import { z } from 'zod';
import type { Db } from 'mongodb';
import { requireFlowAccess, requireFlowProject } from './_flow-access';
import type { FlowEventService } from '../../../services/flow-event-service';

// ---------------------------------------------------------------------------
// flow.register-event
// ---------------------------------------------------------------------------

const RegisterEventSchema = z.object({
  flowId: z.string().min(1),
  projectId: z.string().min(1),
  topic: z.string().min(1),
  rules: z.array(z.record(z.unknown())).optional(),
});

export function createRegisterEventHandler(flowEventService: FlowEventService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const userId = ctx.userId;
    if (!userId || userId.trim() === '') {
      throw new HandlerError('NO_USER_CONTEXT', 'WsHandlerContext.userId missing');
    }

    const parsed = RegisterEventSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    const input = parsed.data;
    const workspaceId = await requireFlowAccess(db, userId, input.flowId, 'write');
    await requireFlowProject(db, workspaceId, input.projectId);

    const result = await flowEventService.registerEvent(
      input.flowId,
      input.projectId,
      userId,
      input.topic,
      input.rules,
    );

    return {
      action: 'registered' as const,
      flowId: input.flowId,
      triggerId: result.triggerId,
      topic: input.topic,
    };
  };
}

// ---------------------------------------------------------------------------
// flow.cancel-event
// ---------------------------------------------------------------------------

const CancelEventSchema = z.object({
  flowId: z.string().min(1),
});

export function createCancelEventHandler(flowEventService: FlowEventService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const parsed = CancelEventSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    await requireFlowAccess(db, ctx.userId, parsed.data.flowId, 'write');
    const cancelled = await flowEventService.cancelEvent(parsed.data.flowId);

    return {
      action: cancelled ? ('cancelled' as const) : ('noop' as const),
      flowId: parsed.data.flowId,
    };
  };
}

// ---------------------------------------------------------------------------
// flow.list-event-triggers
// ---------------------------------------------------------------------------

const ListEventTriggersSchema = z.object({
  flowId: z.string().min(1),
});

export function createListEventTriggersHandler(flowEventService: FlowEventService, db: Db) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    const parsed = ListEventTriggersSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
      throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`);
    }

    await requireFlowAccess(db, ctx.userId, parsed.data.flowId, 'read');
    const triggers = await flowEventService.getTriggersForFlow(parsed.data.flowId);

    return {
      flowId: parsed.data.flowId,
      triggers,
    };
  };
}
