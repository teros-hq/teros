/**
 * feedback-admin actions — the admin feedback console, APIfied.
 *
 * The `feedback` collection is SHARED platform data: end users submit feedback
 * through the backend (http-server.ts `/api/feedback/submit`) and this
 * capability triages it. That is why it cannot live in a per-installation
 * store — both sides must hit the same collection.
 *
 * Since 2026-10-28 the triage logic lives in FeedbackAdminService
 * (services/feedback-admin-service.ts) — the standardized resolution model
 * (tracking / future / dismissed×2 / completed + reporter email) — and this
 * file is the AGENT-facing adapter over it. The app admin panel uses the
 * admin-api.* handlers over the same service.
 *
 * Authorization: every action requires a system admin (`users.role` admin or
 * super), checked server-side against the token's userId — defense in depth
 * beyond the MCA's `availability.role: admin` install gate. `createdBy` is
 * always the token's userId, never a body field.
 */

import type { Db } from 'mongodb';
import { requireSystemAdmin } from '../auth/auth-helpers';
import { HandlerError } from '../ws-framework/WsRouter';
import { FeedbackAdminService, FeedbackValidationError } from '../services/feedback-admin-service';
import {
  DISMISS_REASONS,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  FEEDBACK_VIEWS,
  FEEDBACK_TYPES,
  PRIORITIES,
} from '../services/feedback-admin-service';
import type { McaActionCapability, McaActionCtx } from './index';

const MCA_ID = 'mca.teros.feedback-admin';

/** Map service validation errors to BAD_REQUEST, keep everything else. */
function toHandlerError(err: unknown): never {
  if (err instanceof FeedbackValidationError) {
    throw new HandlerError('BAD_REQUEST', err.message);
  }
  throw err;
}

async function requireAdmin(db: Db, ctx: McaActionCtx): Promise<string> {
  if (!ctx.userId) throw new HandlerError('FORBIDDEN', 'No authenticated user for this token');
  await requireSystemAdmin(db, ctx.userId);
  return ctx.userId;
}

export const feedbackAdminCapability: McaActionCapability = {
  mcaId: MCA_ID,
  actions: {
    /**
     * List feedback with optional filters. `view` selects a lifecycle tab
     * (tracking | future | dismissed | completed | all); a raw `status`
     * filter is still honored for exact queries.
     */
    async list(ctx, db, body) {
      await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      try {
        return await service.list({
          type: parseEnumOrThrow(body.type, FEEDBACK_TYPES, 'type'),
          status: parseEnumOrThrow(body.status, FEEDBACK_STATUSES, 'status'),
          view: parseEnumOrThrow(body.view, FEEDBACK_VIEWS, 'view'),
          priority: parseEnumOrThrow(body.priority, PRIORITIES, 'priority'),
          userId: optionalString(body.userId, 'userId'),
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        });
      } catch (err) {
        toHandlerError(err);
      }
    },

    /** Full details of one feedback report. */
    async get(ctx, db, body) {
      await requireAdmin(db, ctx);
      const feedbackId = requiredString(body.feedbackId, 'feedbackId');
      const service = new FeedbackAdminService(db);
      const feedback = await service.get(feedbackId);
      // Same shape the former tool returned, so the agent-facing contract is unchanged.
      if (!feedback) return { error: 'Feedback not found' };
      return feedback;
    },

    /**
     * Register an out-of-band report — one that arrived outside the feedback
     * tool (a conversation, an email, word of mouth) so that triage has ONE
     * inbox. `source` records where it came from.
     */
    async create(ctx, db, body) {
      const adminUserId = await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      try {
        const doc = await service.create({
          type: parseEnumOrThrow(body.type, FEEDBACK_TYPES, 'type')!,
          title: requiredString(body.title, 'title'),
          description: requiredString(body.description, 'description'),
          severity: optionalString(body.severity, 'severity'),
          reportedBy: requiredString(body.reportedBy, 'reportedBy'),
          reportedByName: optionalString(body.reportedByName, 'reportedByName'),
          reportedByAvatarUrl: optionalString(body.reportedByAvatarUrl, 'reportedByAvatarUrl'),
          agentId: optionalString(body.agentId, 'agentId'),
          source: parseEnumOrThrow(body.source, FEEDBACK_SOURCES, 'source'),
        });
        return {
          success: true,
          feedbackId: doc.feedbackId,
          status: doc.status,
          source: doc.source,
          createdBy: adminUserId,
          message: `Feedback registered (source: ${doc.source}). Track it with ID: ${doc.feedbackId}`,
        };
      } catch (err) {
        toHandlerError(err);
      }
    },

    /**
     * Change status and append a user-visible update entry.
     * Dismissing REQUIRES a dismissReason ('wont_fix' | 'invalid').
     * Resolving emails the reporter unless notifyReporter=false.
     */
    async 'update-status'(ctx, db, body) {
      const adminUserId = await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      try {
        const result = await service.updateStatus({
          feedbackId: requiredString(body.feedbackId, 'feedbackId'),
          status: parseEnumOrThrow(body.status, FEEDBACK_STATUSES, 'status')!,
          message: optionalString(body.message, 'message'),
          dismissReason: parseEnumOrThrow(body.dismissReason, DISMISS_REASONS, 'dismissReason'),
          notifyReporter: body.notifyReporter === false ? false : undefined,
          adminUserId,
        });
        if (!result.success) return { error: result.error };
        return {
          success: true,
          feedbackId: result.feedbackId,
          newStatus: result.newStatus,
          reporterNotified: result.reporterNotified,
          message:
            result.reporterNotified
              ? `Status updated to ${result.newStatus} — reporter emailed`
              : `Status updated to ${result.newStatus}`,
        };
      } catch (err) {
        toHandlerError(err);
      }
    },

    /** Set the triage priority. */
    async 'set-priority'(ctx, db, body) {
      await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      try {
        const result = await service.setPriority({
          feedbackId: requiredString(body.feedbackId, 'feedbackId'),
          priority: parseEnumOrThrow(body.priority, PRIORITIES, 'priority')!,
        });
        if (!result.success) return { error: result.error };
        return { success: true, feedbackId: result.feedbackId, priority: result.priority };
      } catch (err) {
        toHandlerError(err);
      }
    },

    /** Append a user-visible update/comment. */
    async 'add-update'(ctx, db, body) {
      const adminUserId = await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      try {
        const result = await service.addUpdate({
          feedbackId: requiredString(body.feedbackId, 'feedbackId'),
          message: requiredString(body.message, 'message'),
          adminUserId,
        });
        if (!result.success) return { error: result.error };
        return {
          success: true,
          feedbackId: result.feedbackId,
          updateId: result.updateId,
          message: 'Update added successfully. The user will see this when they check their feedback.',
        };
      } catch (err) {
        toHandlerError(err);
      }
    },

    /** Overall statistics. */
    async stats(ctx, db) {
      await requireAdmin(db, ctx);
      const service = new FeedbackAdminService(db);
      return service.stats();
    },
  },
};

// ── local input helpers (kept local so this adapter stays self-contained) ──

function parseEnumOrThrow<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new HandlerError('BAD_REQUEST', `Invalid ${field}`);
  }
  return value as T[number];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HandlerError('BAD_REQUEST', `${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HandlerError('BAD_REQUEST', `Invalid ${field}`);
  return value;
}
