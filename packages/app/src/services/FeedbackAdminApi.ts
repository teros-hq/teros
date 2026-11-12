/**
 * FeedbackAdminApi — Typed client for the feedback admin panel.
 *
 * Wraps the admin-api.feedback-* WebSocket actions over FeedbackAdminService
 * (the shared triage brain for the `feedback` collection). The same service
 * backs the agent-facing mca.teros.feedback-admin tools.
 *
 * Standardized resolution model:
 *   views:   tracking (open|in_review|in_progress) | future (postponed)
 *            | dismissed (wont_fix|invalid) | completed (resolved) | all
 *   intake:  create() registers out-of-band reports (conversation/email/…)
 *   notify:  resolving emails the reporter (unless notifyReporter=false)
 *
 * All actions require a system admin (checked server-side).
 */

import type { Transport } from './transport/types'

// ============================================================================
// Types
// ============================================================================

export type FeedbackAdminType = 'bug' | 'suggestion'

export type FeedbackAdminStatus =
  | 'open'
  | 'in_review'
  | 'in_progress'
  | 'postponed'
  | 'resolved'
  | 'dismissed'

export type FeedbackAdminView = 'all' | 'tracking' | 'future' | 'dismissed' | 'completed'

export type FeedbackDismissReason = 'wont_fix' | 'invalid'

export type FeedbackAdminPriority = 'low' | 'medium' | 'high' | 'critical'

export interface FeedbackAdminUpdate {
  updateId: string
  message: string
  newStatus?: string
  createdAt: string
  createdBy: string
}

export interface FeedbackAdminItem {
  feedbackId: string
  type: FeedbackAdminType
  title: string
  status: FeedbackAdminStatus
  priority?: FeedbackAdminPriority
  severity?: string
  reportedBy: string
  reportedByName?: string
  reportedByAvatarUrl?: string
  dismissReason?: FeedbackDismissReason
  source?: string
  updatesCount: number
  createdAt: string
}

export interface FeedbackAdminDetail {
  feedbackId: string
  type: FeedbackAdminType
  title: string
  description: string
  severity?: string
  reportedBy: string
  reportedByName?: string
  reportedByAvatarUrl?: string
  agentId?: string
  status: FeedbackAdminStatus
  priority?: FeedbackAdminPriority
  dismissReason?: FeedbackDismissReason
  source?: string
  updates: FeedbackAdminUpdate[]
  hasUnreadUpdates: boolean
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  reporterNotifiedAt?: string
  reporterNotifyError?: string
}

export interface FeedbackAdminListResult {
  stats: {
    total: number
    byStatus: Record<string, number>
    byType: Record<string, number>
  }
  feedbacks: FeedbackAdminItem[]
}

export interface FeedbackAdminStats {
  total: number
  byStatus: Record<string, number>
  byType: Record<string, number>
  byPriority: Record<string, number>
  last7Days: number
  last30Days: number
}

// ============================================================================
// API
// ============================================================================

export class FeedbackAdminApi {
  constructor(private readonly transport: Transport) {}

  /** List feedback, optionally filtered by lifecycle view / type / priority / reporter. */
  list(params: {
    view?: FeedbackAdminView
    type?: FeedbackAdminType
    status?: FeedbackAdminStatus
    priority?: FeedbackAdminPriority
    userId?: string
    limit?: number
  } = {}): Promise<FeedbackAdminListResult> {
    return this.transport.request<FeedbackAdminListResult>('admin-api.feedback-list', params)
  }

  /** Full detail of one report. */
  get(feedbackId: string): Promise<FeedbackAdminDetail> {
    return this.transport.request<FeedbackAdminDetail>('admin-api.feedback-get', { feedbackId })
  }

  /**
   * Change status. Dismissing requires `dismissReason` ('wont_fix' | 'invalid').
   * Resolving emails the reporter unless `notifyReporter` is false.
   */
  updateStatus(params: {
    feedbackId: string
    status: FeedbackAdminStatus
    message?: string
    dismissReason?: FeedbackDismissReason
    notifyReporter?: boolean
  }): Promise<{ success: true; feedbackId: string; newStatus: FeedbackAdminStatus; reporterNotified: boolean }> {
    return this.transport.request('admin-api.feedback-update-status', params)
  }

  /** Set the triage priority. */
  setPriority(
    feedbackId: string,
    priority: FeedbackAdminPriority,
  ): Promise<{ success: true; feedbackId: string; priority: FeedbackAdminPriority }> {
    return this.transport.request('admin-api.feedback-set-priority', { feedbackId, priority })
  }

  /** Append a user-visible update the reporter sees on their feedback timeline. */
  addUpdate(
    feedbackId: string,
    message: string,
  ): Promise<{ success: true; feedbackId: string; updateId: string; message: string }> {
    return this.transport.request('admin-api.feedback-add-update', { feedbackId, message })
  }

  /** Overall statistics. */
  stats(): Promise<FeedbackAdminStats> {
    return this.transport.request<FeedbackAdminStats>('admin-api.feedback-stats')
  }
}
