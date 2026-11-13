/**
 * Security Audit Logger (Req 6.5.1)
 *
 * Provides structured audit logging for security-relevant events:
 * - Logins (success and failure, password + OAuth + MFA)
 * - Role changes
 * - Impersonation (start and stop)
 * - Secret access (system + MCA secrets)
 *
 * Each audit event is:
 * 1. Persisted to the `audit_logs` MongoDB collection (queryable, retains 90 days)
 * 2. Emitted as a structured pino log line (for log aggregators / SIEM)
 *
 * Usage:
 *   import { auditLogger } from '../lib/audit-logger'
 *   await auditLogger.log({
 *     event: 'login.success',
 *     userId: 'user:abc123',
 *     ip: '1.2.3.4',
 *     detail: { method: 'password' },
 *   })
 */

import type { Collection, Db, ObjectId } from 'mongodb'
import { COLLECTIONS, ensureCollectionIndexes } from '../db'
import { createLogger } from './logger'

const log = createLogger('AuditLogger')

// ============================================================================
// TYPES
// ============================================================================

/** All security-relevant audit event types */
export type AuditEventType =
  // Authentication events
  | 'login.success'
  | 'login.failure'
  | 'login.mfa_required'
  | 'login.mfa_success'
  | 'login.mfa_failure'
  | 'login.email_verification_required'
  | 'login.email_verification_failure'
  | 'login.email_verified'
  | 'login.unverified_access_revoked'
  | 'logout'
  | 'session.revoked'
  | 'session.refreshed'
  | 'register.success'
  | 'register.failure'
  // Authorization / role events
  | 'role.change'
  | 'status.change'
  | 'access.grant'
  | 'access.revoke'
  // Impersonation events
  | 'impersonation.start'
  | 'impersonation.stop'
  // Secret access events
  | 'secret.access'
  // Step-up authentication
  | 'stepup.success'
  | 'stepup.failure'
  // Password changes
  | 'password.change'
  // Password reset
  | 'password_reset.requested'
  | 'password_reset.request_limited'
  | 'password_reset.request_decoy'
  | 'password_reset.provisioned_identity'
  | 'password_reset.verify_failed'
  | 'password_reset.decoy_consumed'
  | 'password_reset.completed'
  // Workspace membership funnel (MUW-REQ-18, MUW-REQ-20..22)
  | 'workspace.invite_sent'
  | 'workspace.invite_resent'
  | 'workspace.invite_revoked'
  | 'workspace.invite_accepted'
  | 'workspace.invite_declined'
  | 'workspace.member_removed'
  | 'workspace.member_role_changed'
  | 'workspace.member_left'

/** The severity level of an audit event */
export type AuditSeverity = 'info' | 'warning' | 'critical'

/** A complete audit log entry as stored in MongoDB */
export interface AuditLogEntry {
  _id?: ObjectId
  /** The type of security event */
  event: AuditEventType
  /** When the event occurred (epoch ms) */
  timestamp: number
  /** Severity: info for normal events, warning for failures, critical for privilege escalation */
  severity: AuditSeverity
  /** The user who performed the action (if known) */
  actorUserId?: string
  /** The user affected by the action (e.g. target of role change or impersonation) */
  targetUserId?: string
  /** IP address of the actor */
  ip?: string
  /** User agent of the actor */
  userAgent?: string
  /** Additional event-specific data (never contains secrets/tokens) */
  detail?: Record<string, unknown>
  /** TTL field — used by the MongoDB TTL index to auto-expire after 90 days */
  expireAt?: Date
}

/** Parameters for logging an audit event */
export interface AuditLogParams {
  event: AuditEventType
  actorUserId?: string
  targetUserId?: string
  ip?: string
  userAgent?: string
  detail?: Record<string, unknown>
}

// ============================================================================
// AUDIT LOGGER
// ============================================================================

class AuditLogger {
  private collection: Collection<AuditLogEntry> | null = null
  private initialized = false

  /**
   * Initialize the audit logger with a database instance.
   * Called once during server bootstrap.
   */
  init(db: Db): void {
    if (this.initialized) {
      return
    }
    this.collection = db.collection<AuditLogEntry>('audit_logs')
    this.initialized = true
    log.info('Audit logger initialized (collection: audit_logs)')
  }

  /**
   * Ensure indexes on the audit_logs collection.
   * Called during server bootstrap after init().
   */
  async ensureIndexes(): Promise<void> {
    if (!this.collection) {
      log.warn('ensureIndexes called before init() — skipping')
      return
    }
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.collection, COLLECTIONS.auditLogs)
    // TTL index on expireAt removed (2026-09-23): evidence collections never
    // expire per product decision. The expireAt field is still written on new
    // docs for backward compat but is inert without the index.
    log.info('Audit log indexes ensured')
  }

  /**
   * Determine the severity of an event type.
   */
  private getSeverity(event: AuditEventType): AuditSeverity {
    // Critical: privilege escalation, impersonation
    const critical: AuditEventType[] = [
      'role.change',
      'impersonation.start',
      'impersonation.stop',
    ]
    // Warning: failures, denied access, secret access
    const warning: AuditEventType[] = [
      'login.failure',
      'login.mfa_failure',
      'login.mfa_required',
      'login.email_verification_failure',
      'login.unverified_access_revoked',
      'stepup.failure',
      'access.revoke',
      'secret.access',
      'status.change',
    ]

    if (critical.includes(event)) return 'critical'
    if (warning.includes(event)) return 'warning'
    return 'info'
  }

  /**
   * Log a security audit event.
   *
   * Persists to the `audit_logs` MongoDB collection AND emits a structured
   * pino log line. The pino log is always emitted (even if DB persistence
   * fails) so audit events are never silently lost.
   *
   * This method is fire-and-forget safe — it never throws. If the DB write
   * fails, the pino log line still carries the full event.
   */
  async log(params: AuditLogParams): Promise<void> {
    const severity = this.getSeverity(params.event)

    const entry: AuditLogEntry = {
      event: params.event,
      timestamp: Date.now(),
      severity,
      actorUserId: params.actorUserId,
      targetUserId: params.targetUserId,
      ip: params.ip,
      userAgent: params.userAgent,
      detail: params.detail,
    }

    // 1. Always emit a structured pino log line (for SIEM / log aggregators)
    //    Use the appropriate log level based on severity
    const logPayload = {
      audit: true,
      event: entry.event,
      severity: entry.severity,
      actorUserId: entry.actorUserId,
      targetUserId: entry.targetUserId,
      ip: entry.ip,
      detail: entry.detail,
    }
    switch (severity) {
      case 'critical':
        log.warn(logPayload, `SECURITY AUDIT [critical]: ${entry.event}`)
        break
      case 'warning':
        log.warn(logPayload, `SECURITY AUDIT [warning]: ${entry.event}`)
        break
      default:
        log.info(logPayload, `SECURITY AUDIT [info]: ${entry.event}`)
    }

    // 2. Persist to MongoDB (best-effort — don't block or throw on failure)
    if (this.collection) {
      try {
        // expireAt field omitted: the TTL index was dropped (2026-09-23) per
        // product decision that evidence never expires. Existing docs retain
        // their expireAt field (inert without the index).
        await this.collection.insertOne(entry)
      } catch (err) {
        // Don't let a DB failure prevent the operation from completing.
        // The pino log line above already captured the event.
        log.error(
          { err, event: entry.event },
          'Failed to persist audit log entry to MongoDB — event was emitted to pino only',
        )
      }
    } else {
      // Collection not initialized — pino log is our only record
      log.debug(
        { event: entry.event },
        'Audit logger not initialized — event emitted to pino only',
      )
    }
  }

  /**
   * Query audit logs (for admin/audit review).
   */
  async query(filter: {
    event?: AuditEventType
    actorUserId?: string
    targetUserId?: string
    startTime?: number
    endTime?: number
    limit?: number
  }): Promise<AuditLogEntry[]> {
    if (!this.collection) {
      return []
    }

    const query: Record<string, unknown> = {}
    if (filter.event) query.event = filter.event
    if (filter.actorUserId) query.actorUserId = filter.actorUserId
    if (filter.targetUserId) query.targetUserId = filter.targetUserId
    if (filter.startTime || filter.endTime) {
      query.timestamp = {}
      if (filter.startTime) (query.timestamp as Record<string, unknown>).$gte = filter.startTime
      if (filter.endTime) (query.timestamp as Record<string, unknown>).$lte = filter.endTime
    }

    return this.collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(filter.limit ?? 100)
      .toArray()
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

export const auditLogger = new AuditLogger()
