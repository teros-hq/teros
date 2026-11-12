/**
 * Feedback Admin Service — the triage brain for the shared `feedback`
 * collection (user-submitted bugs & suggestions).
 *
 * Extracted from mca-actions/feedback-admin.ts so two adapters can share it:
 *   - mca-actions/feedback-admin.ts   (agent tools, via MCA callback)
 *   - handlers/domains/admin-api/feedback.ts (admin panel UI, via WS actions)
 *
 * STANDARDIZED RESOLUTION MODEL (task tn_e86UrjJtC4y9JCOb, 2026-10-28):
 *
 *   Lifecycle views:
 *     - "tracking"  → open | in_review | in_progress  (active work queue)
 *     - "future"    → postponed                        (parked, revisit later)
 *     - "dismissed" → dismissed                        (with a reason)
 *     - "completed" → resolved                         (done)
 *
 *   Dismissed has TWO subtypes (dismissReason):
 *     - 'wont_fix'  → valid report, but we won't do it (by product decision)
 *     - 'invalid'   → not a real bug / not reproducible / spam
 *
 *   Reporter notification: when an item transitions to `resolved`, an email
 *   is sent to the reporter (users.profile.email lookup by reportedBy). The
 *   send is non-fatal — triage never fails because an email bounced — and
 *   the outcome is recorded in `reporterNotifiedAt` / `reporterNotifyError`
 *   for auditability.
 *
 *   Intake: `create()` registers out-of-band reports (arrived via
 *   conversation/email/word of mouth instead of the feedback tool) with a
 *   `source` field, so everything lands in ONE place. This is the
 *   standardization the task asks for: the HubSpot bug reported by Álvaro
 *   via a direct conversation is the canonical example.
 *
 * Backward compatibility: the stored `status` values are unchanged
 * (open/in_review/in_progress/resolved/dismissed) plus the new `postponed`.
 * `resolved` is what the panel labels "Completed". No data migration needed;
 * old docs simply lack dismissReason/source/reporterNotifiedAt.
 */

import type { Db, Collection } from 'mongodb';
import { createLogger } from '../lib/logger';
import { getEmailService } from './email-service';

const log = createLogger('FeedbackAdminService');

// ============================================================================
// TYPES
// ============================================================================

export const FEEDBACK_TYPES = ['bug', 'suggestion'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = [
  'open',
  'in_review',
  'in_progress',
  'postponed',
  'resolved',
  'dismissed',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Lifecycle buckets the admin panel renders as tabs. */
export const FEEDBACK_VIEWS = ['all', 'tracking', 'future', 'dismissed', 'completed'] as const;
export type FeedbackView = (typeof FEEDBACK_VIEWS)[number];

/** The two dismissal subtypes (task: "dismissed (2 tipos)"). */
export const DISMISS_REASONS = ['wont_fix', 'invalid'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FeedbackPriority = (typeof PRIORITIES)[number];

/** Where a report came from. 'tool' is the classic report-bug/report-suggestion path. */
export const FEEDBACK_SOURCES = ['tool', 'conversation', 'email', 'manual'] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export interface FeedbackUpdate {
  updateId: string;
  message: string;
  newStatus?: string;
  createdAt: string;
  createdBy: string;
}

export interface FeedbackDoc {
  feedbackId: string;
  type: FeedbackType;
  title: string;
  description: string;
  severity?: string;
  reportedBy: string;
  reportedByName?: string;
  reportedByAvatarUrl?: string;
  agentId?: string;
  /** Lifecycle: open | in_review | in_progress | postponed | resolved | dismissed */
  status: FeedbackStatus;
  priority?: FeedbackPriority;
  /** Why it was dismissed — required when status is 'dismissed'. */
  dismissReason?: DismissReason;
  /** Intake channel. Old docs (submitted via the tool) default to 'tool'. */
  source?: FeedbackSource;
  updates: FeedbackUpdate[];
  hasUnreadUpdates: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  /** Set when the reporter was emailed about resolution. */
  reporterNotifiedAt?: string;
  reporterNotifyError?: string;
}

export interface ListFeedbackInput {
  type?: FeedbackType;
  status?: FeedbackStatus;
  view?: FeedbackView;
  priority?: FeedbackPriority;
  userId?: string;
  limit?: number;
}

export interface CreateFeedbackInput {
  type: FeedbackType;
  title: string;
  description: string;
  severity?: string;
  reportedBy: string;
  reportedByName?: string;
  reportedByAvatarUrl?: string;
  agentId?: string;
  source?: FeedbackSource;
}

export interface UpdateStatusInput {
  feedbackId: string;
  status: FeedbackStatus;
  message?: string;
  /** Required when status === 'dismissed' — the two subtypes. */
  dismissReason?: DismissReason;
  /** Default true — email the reporter when the item becomes resolved. */
  notifyReporter?: boolean;
  /** Admin performing the change (recorded on the update entry). */
  adminUserId: string;
}

export interface SetPriorityInput {
  feedbackId: string;
  priority: FeedbackPriority;
}

export interface AddUpdateInput {
  feedbackId: string;
  message: string;
  adminUserId: string;
}

export interface ListResult {
  stats: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  feedbacks: Array<
    Pick<
      FeedbackDoc,
      | 'feedbackId'
      | 'type'
      | 'title'
      | 'status'
      | 'priority'
      | 'severity'
      | 'reportedBy'
      | 'reportedByName'
      | 'reportedByAvatarUrl'
      | 'dismissReason'
      | 'source'
    > & { updatesCount: number; createdAt: string }
  >;
}

export interface StatsResult {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  last7Days: number;
  last30Days: number;
}

// ============================================================================
// VIEW → STATUS MAPPING
// ============================================================================

const TRACKING_STATUSES: ReadonlySet<string> = new Set(['open', 'in_review', 'in_progress']);

/** Map a lifecycle view tab to a Mongo query on `status`. */
export function viewToStatusQuery(view: FeedbackView): Record<string, unknown> | null {
  switch (view) {
    case 'tracking':
      return { status: { $in: ['open', 'in_review', 'in_progress'] } };
    case 'future':
      return { status: 'postponed' };
    case 'dismissed':
      return { status: 'dismissed' };
    case 'completed':
      return { status: 'resolved' };
    case 'all':
    default:
      return null; // no filter
  }
}

export function isTrackingStatus(status: string): boolean {
  return TRACKING_STATUSES.has(status);
}

// ============================================================================
// VALIDATION HELPERS (thrown as plain Errors; adapters map to HandlerError)
// ============================================================================

export class FeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackValidationError';
  }
}

export function parseFeedbackType(value: unknown): FeedbackType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid type`);
  }
  return value as FeedbackType;
}

export function parseFeedbackStatus(value: unknown): FeedbackStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(FEEDBACK_STATUSES as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid status`);
  }
  return value as FeedbackStatus;
}

export function parseFeedbackView(value: unknown): FeedbackView | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(FEEDBACK_VIEWS as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid view`);
  }
  return value as FeedbackView;
}

export function parseDismissReason(value: unknown): DismissReason | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(DISMISS_REASONS as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid dismissReason`);
  }
  return value as DismissReason;
}

export function parsePriority(value: unknown): FeedbackPriority | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid priority`);
  }
  return value as FeedbackPriority;
}

export function parseSource(value: unknown): FeedbackSource | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(FEEDBACK_SOURCES as readonly string[]).includes(value)) {
    throw new FeedbackValidationError(`Invalid source`);
  }
  return value as FeedbackSource;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FeedbackValidationError(`${field} is required`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new FeedbackValidationError(`Invalid ${field}`);
  return value;
}

// ============================================================================
// SERVICE
// ============================================================================

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).substring(2, 15)}`;
}

function countBy<K extends string>(
  items: FeedbackDoc[],
  keys: readonly K[],
  pick: (f: FeedbackDoc) => string | undefined,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  for (const f of items) {
    const v = pick(f) as K | undefined;
    if (v !== undefined && v in out) out[v] += 1;
  }
  return out;
}

export class FeedbackAdminService {
  private collection: Collection<FeedbackDoc>;

  constructor(private db: Db) {
    this.collection = db.collection<FeedbackDoc>('feedback');
  }

  // ── List ────────────────────────────────────────────────────────────────

  async list(input: ListFeedbackInput): Promise<ListResult> {
    const query: Record<string, unknown> = {};
    if (input.type) query.type = input.type;
    if (input.status) query.status = input.status;
    if (input.priority) query.priority = input.priority;
    if (input.userId) query.reportedBy = input.userId;

    // A view (lifecycle tab) and an explicit status are mutually exclusive;
    // the view wins when both arrive, since the panel sends one or the other.
    const statusQuery = viewToStatusQuery(input.view ?? 'all');
    if (statusQuery) Object.assign(query, statusQuery);

    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : DEFAULT_LIST_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIST_LIMIT);

    const feedbacks = await this.collection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return {
      stats: {
        total: feedbacks.length,
        byStatus: countBy(feedbacks, FEEDBACK_STATUSES, (f) => f.status),
        byType: countBy(feedbacks, FEEDBACK_TYPES, (f) => f.type),
      },
      feedbacks: feedbacks.map((f) => ({
        feedbackId: f.feedbackId,
        type: f.type,
        title: f.title,
        status: f.status,
        priority: f.priority,
        severity: f.severity,
        reportedBy: f.reportedBy,
        reportedByName: f.reportedByName,
        reportedByAvatarUrl: f.reportedByAvatarUrl,
        dismissReason: f.dismissReason,
        source: f.source,
        updatesCount: f.updates?.length ?? 0,
        createdAt: f.createdAt,
      })),
    };
  }

  // ── Get one ────────────────────────────────────────────────────────────

  async get(feedbackId: string): Promise<FeedbackDoc | null> {
    return this.collection.findOne({ feedbackId }, { projection: { _id: 0 } });
  }

  // ── Create (out-of-band intake) ─────────────────────────────────────────

  /**
   * Register a report that arrived outside the feedback tool — e.g. a bug
   * mentioned in a conversation (the HubSpot/Álvaro case) or by email.
   * Everything lands in the same collection so triage has ONE inbox.
   */
  async create(input: CreateFeedbackInput): Promise<FeedbackDoc> {
    const now = new Date().toISOString();
    const doc: FeedbackDoc = {
      feedbackId: generateId('fb'),
      type: input.type,
      title: input.title,
      description: input.description,
      severity: input.severity,
      reportedBy: input.reportedBy,
      reportedByName: input.reportedByName,
      reportedByAvatarUrl: input.reportedByAvatarUrl,
      agentId: input.agentId,
      status: 'open',
      source: input.source ?? 'manual',
      updates: [],
      hasUnreadUpdates: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(doc);
    return doc;
  }

  // ── Update status ───────────────────────────────────────────────────────

  async updateStatus(input: UpdateStatusInput): Promise<
    | {
        success: true;
        feedbackId: string;
        newStatus: FeedbackStatus;
        reporterNotified: boolean;
      }
    | { success: false; error: string }
  > {
    const existing = await this.collection.findOne({ feedbackId: input.feedbackId });
    if (!existing) return { success: false, error: 'Feedback not found' };

    if (input.status === 'dismissed' && !input.dismissReason) {
      throw new FeedbackValidationError('dismissReason is required when status is dismissed (wont_fix | invalid)');
    }
    if (input.status !== 'dismissed' && input.dismissReason) {
      throw new FeedbackValidationError('dismissReason only applies to status dismissed');
    }

    const now = new Date().toISOString();
    const set: Record<string, unknown> = {
      status: input.status,
      updatedAt: now,
      hasUnreadUpdates: true,
    };
    if (input.status === 'resolved' || input.status === 'dismissed') set.resolvedAt = now;
    if (input.status === 'dismissed') set.dismissReason = input.dismissReason;
    else set.dismissReason = undefined; // clear on any non-dismissed transition

    const update: FeedbackUpdate = {
      updateId: generateId('upd'),
      message: input.message || defaultStatusMessage(input.status, input.dismissReason),
      newStatus: input.status,
      createdAt: now,
      createdBy: input.adminUserId,
    };

    await this.collection.updateOne(
      { feedbackId: input.feedbackId },
      { $set: set, $push: { updates: update } },
    );

    // Reporter notification on completion (task: "considerar enviar email al
    // reportador cuando su item queda listo"). Non-fatal by design.
    let reporterNotified = false;
    if (input.status === 'resolved' && input.notifyReporter !== false) {
      reporterNotified = await this.notifyReporter(existing, input.message);
    }

    return { success: true, feedbackId: input.feedbackId, newStatus: input.status, reporterNotified };
  }

  // ── Set priority ────────────────────────────────────────────────────────

  async setPriority(
    input: SetPriorityInput,
  ): Promise<{ success: true; feedbackId: string; priority: FeedbackPriority } | { success: false; error: string }> {
    const result = await this.collection.updateOne(
      { feedbackId: input.feedbackId },
      { $set: { priority: input.priority, updatedAt: new Date().toISOString() } },
    );
    if (result.matchedCount === 0) return { success: false, error: 'Feedback not found' };
    return { success: true, feedbackId: input.feedbackId, priority: input.priority };
  }

  // ── Add update (user-visible comment) ───────────────────────────────────

  async addUpdate(
    input: AddUpdateInput,
  ): Promise<{ success: true; feedbackId: string; updateId: string } | { success: false; error: string }> {
    const existing = await this.collection.findOne({ feedbackId: input.feedbackId });
    if (!existing) return { success: false, error: 'Feedback not found' };

    const now = new Date().toISOString();
    const update: FeedbackUpdate = {
      updateId: generateId('upd'),
      message: input.message,
      createdAt: now,
      createdBy: input.adminUserId,
    };
    await this.collection.updateOne(
      { feedbackId: input.feedbackId },
      { $set: { updatedAt: now, hasUnreadUpdates: true }, $push: { updates: update } },
    );
    return { success: true, feedbackId: input.feedbackId, updateId: update.updateId };
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  async stats(): Promise<StatsResult> {
    const all = await this.collection.find({}).toArray();
    const now = Date.now();
    const last7 = now - 7 * 24 * 60 * 60 * 1000;
    const last30 = now - 30 * 24 * 60 * 60 * 1000;
    const ts = (f: FeedbackDoc) => new Date(f.createdAt).getTime();
    return {
      total: all.length,
      byStatus: countBy(all, FEEDBACK_STATUSES, (f) => f.status),
      byType: countBy(all, FEEDBACK_TYPES, (f) => f.type),
      byPriority: {
        ...countBy(all, PRIORITIES, (f) => f.priority),
        unset: all.filter((f) => !f.priority).length,
      },
      last7Days: all.filter((f) => ts(f) >= last7).length,
      last30Days: all.filter((f) => ts(f) >= last30).length,
    };
  }

  // ── Reporter notification ───────────────────────────────────────────────

  /**
   * Email the reporter that their item is done. Looks the address up from
   * users.profile.email via the stored reportedBy userId. Returns whether the
   * send succeeded; failures are logged and recorded on the doc, never thrown.
   */
  private async notifyReporter(feedback: FeedbackDoc, message?: string): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      const user = await this.db.collection<{ profile?: { email?: string; displayName?: string } }>('users').findOne(
        { userId: feedback.reportedBy },
        { projection: { 'profile.email': 1, 'profile.displayName': 1, _id: 0 } },
      );
      const email = user?.profile?.email;
      if (!email) {
        log.warn(`Cannot notify reporter for ${feedback.feedbackId}: no email for user ${feedback.reportedBy}`);
        await this.collection.updateOne(
          { feedbackId: feedback.feedbackId },
          { $set: { reporterNotifyError: 'no email on file' } },
        );
        return false;
      }

      const emailService = getEmailService(this.db);
      await emailService.sendFeedbackResolved(email, {
        FEEDBACK_ID: feedback.feedbackId,
        TITLE: feedback.title,
        TYPE: feedback.type,
        TYPE_LABEL: feedback.type === 'bug' ? 'Bug report' : 'Suggestion',
        RESOLUTION_NOTE: message || '',
        DATE: now,
      });

      await this.collection.updateOne(
        { feedbackId: feedback.feedbackId },
        { $set: { reporterNotifiedAt: now }, $unset: { reporterNotifyError: '' } },
      );
      log.info(`Reporter notified for ${feedback.feedbackId} → ${email}`);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`Failed to notify reporter for ${feedback.feedbackId}: ${reason}`);
      // Non-fatal — record and move on.
      try {
        await this.collection.updateOne(
          { feedbackId: feedback.feedbackId },
          { $set: { reporterNotifyError: reason } },
        );
      } catch (recordErr) {
        log.error(`Failed to record reporterNotifyError for ${feedback.feedbackId}: ${recordErr}`);
      }
      return false;
    }
  }
}

/**
 * Human-readable default message for a status change with no admin note.
 * Shown to the reporter in their feedback timeline.
 */
function defaultStatusMessage(status: FeedbackStatus, dismissReason?: DismissReason): string {
  switch (status) {
    case 'open':
      return 'Reopened — back in the tracking queue';
    case 'in_review':
      return 'The team is reviewing this report';
    case 'in_progress':
      return 'The team is working on this';
    case 'postponed':
      return 'Postponed — parked on the Future list to revisit later';
    case 'resolved':
      return 'Completed — your report has been addressed';
    case 'dismissed':
      return dismissReason === 'wont_fix'
        ? 'Dismissed — valid report, but we have decided not to implement it'
        : 'Dismissed — we could not reproduce this or it is not a bug';
    default:
      return `Status changed to ${status}`;
  }
}
