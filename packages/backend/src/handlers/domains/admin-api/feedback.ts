/**
 * admin-api.feedback — Feedback admin panel actions (HTTP→WS migration).
 *
 * WS actions for the FeedbackAdminWindow (app admin panel). Thin wrappers over
 * FeedbackAdminService — the same service the agent-facing MCA
 * (mca.teros.feedback-admin) uses, so agents and the panel always agree on
 * the standardized resolution model:
 *
 *   views:  tracking (open|in_review|in_progress) | future (postponed)
 *           | dismissed (wont_fix|invalid) | completed (resolved)
 *
 * Actions:
 *   admin-api.feedback-list    → list with view/status/type/priority filters
 *   admin-api.feedback-get     → one report, full detail
 *   admin-api.feedback-update-status → change status (+ dismissReason, reporter email)
 *   admin-api.feedback-set-priority   → set triage priority
 *   admin-api.feedback-add-update    → append user-visible update
 *   admin-api.feedback-stats         → overall statistics
 *
 * Authorization: system admin (users.role admin|super) on every action.
 */

import type { Db } from "mongodb"
import type { WsHandlerContext } from "@teros/shared"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import {
  FeedbackAdminService,
  FeedbackValidationError,
} from "../../../services/feedback-admin-service"
import {
  DISMISS_REASONS,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  FEEDBACK_VIEWS,
  PRIORITIES,
} from "../../../services/feedback-admin-service"

// ── helpers ────────────────────────────────────────────────────────────────

function toHandlerError(err: unknown): never {
  if (err instanceof FeedbackValidationError) {
    throw new HandlerError("BAD_REQUEST", err.message)
  }
  throw err
}

function parseEnumOrThrow<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new HandlerError("BAD_REQUEST", `Invalid ${field}`)
  }
  return value as T[number]
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HandlerError("BAD_REQUEST", `${field} is required`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new HandlerError("BAD_REQUEST", `Invalid ${field}`)
  return value
}

async function requireAdmin(db: Db, ctx: WsHandlerContext): Promise<string> {
  if (!ctx.userId) throw new HandlerError("FORBIDDEN", "No authenticated user")
  await requireSystemAdmin(db, ctx.userId)
  return ctx.userId
}

// ── handler factories ──────────────────────────────────────────────────────

export function createFeedbackListHandler(db: Db) {
  return async function feedbackList(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx)
    const body = (rawData ?? {}) as Record<string, unknown>
    const service = new FeedbackAdminService(db)
    try {
      return await service.list({
        type: parseEnumOrThrow(body.type, FEEDBACK_TYPES, "type"),
        status: parseEnumOrThrow(body.status, FEEDBACK_STATUSES, "status"),
        view: parseEnumOrThrow(body.view, FEEDBACK_VIEWS, "view"),
        priority: parseEnumOrThrow(body.priority, PRIORITIES, "priority"),
        userId: optionalString(body.userId, "userId"),
        limit: typeof body.limit === "number" ? body.limit : undefined,
      })
    } catch (err) {
      toHandlerError(err)
    }
  }
}

export function createFeedbackGetHandler(db: Db) {
  return async function feedbackGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx)
    const body = (rawData ?? {}) as Record<string, unknown>
    const service = new FeedbackAdminService(db)
    const feedback = await service.get(requiredString(body.feedbackId, "feedbackId"))
    if (!feedback) throw new HandlerError("NOT_FOUND", "Feedback not found")
    return feedback
  }
}

export function createFeedbackUpdateStatusHandler(db: Db) {
  return async function feedbackUpdateStatus(ctx: WsHandlerContext, rawData: unknown) {
    const adminUserId = await requireAdmin(db, ctx)
    const body = (rawData ?? {}) as Record<string, unknown>
    const service = new FeedbackAdminService(db)
    try {
      const result = await service.updateStatus({
        feedbackId: requiredString(body.feedbackId, "feedbackId"),
        status: parseEnumOrThrow(body.status, FEEDBACK_STATUSES, "status")!,
        message: optionalString(body.message, "message"),
        dismissReason: parseEnumOrThrow(body.dismissReason, DISMISS_REASONS, "dismissReason"),
        notifyReporter: body.notifyReporter === false ? false : undefined,
        adminUserId,
      })
      if (!result.success) throw new HandlerError("NOT_FOUND", result.error)
      return result
    } catch (err) {
      toHandlerError(err)
    }
  }
}

export function createFeedbackSetPriorityHandler(db: Db) {
  return async function feedbackSetPriority(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx)
    const body = (rawData ?? {}) as Record<string, unknown>
    const service = new FeedbackAdminService(db)
    try {
      const result = await service.setPriority({
        feedbackId: requiredString(body.feedbackId, "feedbackId"),
        priority: parseEnumOrThrow(body.priority, PRIORITIES, "priority")!,
      })
      if (!result.success) throw new HandlerError("NOT_FOUND", result.error)
      return result
    } catch (err) {
      toHandlerError(err)
    }
  }
}

export function createFeedbackAddUpdateHandler(db: Db) {
  return async function feedbackAddUpdate(ctx: WsHandlerContext, rawData: unknown) {
    const adminUserId = await requireAdmin(db, ctx)
    const body = (rawData ?? {}) as Record<string, unknown>
    const service = new FeedbackAdminService(db)
    try {
      const result = await service.addUpdate({
        feedbackId: requiredString(body.feedbackId, "feedbackId"),
        message: requiredString(body.message, "message"),
        adminUserId,
      })
      if (!result.success) throw new HandlerError("NOT_FOUND", result.error)
      return {
        success: true,
        feedbackId: result.feedbackId,
        updateId: result.updateId,
        message: "Update added. The reporter will see it when they check their feedback.",
      }
    } catch (err) {
      toHandlerError(err)
    }
  }
}

export function createFeedbackStatsHandler(db: Db) {
  return async function feedbackStats(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx)
    const service = new FeedbackAdminService(db)
    return service.stats()
  }
}
