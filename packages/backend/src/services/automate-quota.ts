/**
 * AutomateQuotaService — daily cap on Automate executions per subscriber.
 *
 * Users set up per-minute crons without realising each firing wakes an agent
 * and burns tokens; a handful of those degrade the platform for everyone.
 * The cap is a plan attribute (`billing_plans.automateDailyExecutionLimit`,
 * overridable per subscription) and scales with the tier like agent-hours:
 * Seed 5 · Starter 20 · Growth 50 · Pro 100 · Ultra 200 · Enterprise ∞.
 *
 * Semantics:
 *   - Counted against the starter's creator (`starter.createdBy`), the same
 *     identity the billing gate charges hours to — across all their starters
 *     and workspaces, whatever the trigger kind (scheduler, once, webhook,
 *     event). Five different starters firing once each on the same day use
 *     the same budget as one starter firing five times.
 *   - The window is the UTC calendar day: the budget resets at 00:00Z.
 *   - Only executions that actually ran count (`refused: {$ne: true}`); a
 *     refusal is recorded for the history but never consumes budget nor
 *     counts toward the starter's failure cap (see AutomateRunner).
 *   - The FIRST refusal of a user's day fires `onExhausted` once (toast +
 *     banner + chat block, wired in bootstrap). The other 1,435 refusals of
 *     a per-minute cron stay silent: the user was told, and the history
 *     shows every skipped run.
 *   - Fail open: a lookup error allows the execution (the billing gate and
 *     the structural gate at dispatch still protect cost), but is logged.
 */

import type { Db } from 'mongodb'
import type { AutomateModel } from '../models/automate'
import {
  DEFAULT_PLAN_ID,
  type BillingPlan,
  getActiveSubscription,
  getBillingPlansCollection,
  getEffectiveAutomateDailyLimit,
} from '../models/billing'
import type { AutomateStarter } from '../types/database-automate'
import type { AutomateGateResult } from './automate-runner'

/** Error prefix on refused rows — the window, the webhook route and the agent tools key on it. */
export const AUTOMATE_QUOTA_REASON = 'quota-automate_daily_limit'

export interface AutomateQuotaStatus {
  /** Effective cap for the creator; 0 ⇒ unmetered. */
  limit: number
  /** Executions already run today (UTC). */
  used: number
  /** Executions still available today; null when unmetered. */
  remaining: number | null
  exhausted: boolean
  planId: string
  planName: string
  /** Next 00:00 UTC (ISO): when the budget resets. */
  resetsAt: string
}

export interface AutomateQuotaTopStarter {
  starterId: string
  name: string
  workspaceId: string
  count: number
}

/** What the notice receivers (toast, banner, chat block) get on the first refusal of the day. */
export interface AutomateQuotaExhaustedNotice extends AutomateQuotaStatus {
  userId: string
  /** The starter whose run was refused. */
  starterId: string
  starterName: string
  workspaceId: string
  /** The creator's busiest starters today — "this one ate the budget". */
  topStarters: AutomateQuotaTopStarter[]
}

export type AutomateQuotaExhaustedHook = (starter: AutomateStarter, notice: AutomateQuotaExhaustedNotice) => Promise<void>

/** 00:00:00.000Z of the UTC day containing `now`. */
export function startOfUtcDay(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

/** 00:00:00.000Z of the UTC day after `now`. */
export function nextUtcMidnight(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

export class AutomateQuotaService {
  private onExhausted: AutomateQuotaExhaustedHook | null = null

  constructor(
    private readonly db: Db,
    private readonly model: AutomateModel,
  ) {}

  /** Receiver of the once-a-day exhaustion notice (wired in bootstrap). */
  setOnExhausted(hook: AutomateQuotaExhaustedHook | null): void {
    this.onExhausted = hook
  }

  /** Cap and usage for a creator, for the gate, the window and the agent tools. */
  async getStatus(createdBy: string, now: Date = new Date()): Promise<AutomateQuotaStatus> {
    const sub = await getActiveSubscription(this.db, createdBy)
    const plansCol = getBillingPlansCollection(this.db)
    let plan: BillingPlan | null = sub ? await plansCol.findOne({ _id: sub.planId }) : null
    if (!plan) plan = await plansCol.findOne({ _id: DEFAULT_PLAN_ID })

    const limit = plan ? getEffectiveAutomateDailyLimit(sub, plan) : 0
    const used = limit > 0 ? await this.model.countExecutionsByCreatorSince(createdBy, startOfUtcDay(now)) : 0
    return {
      limit,
      used,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      exhausted: limit > 0 && used >= limit,
      planId: plan?._id ?? DEFAULT_PLAN_ID,
      planName: plan?.displayName ?? 'unknown',
      resetsAt: nextUtcMidnight(now),
    }
  }

  /** The creator's busiest starters today, refusals excluded. */
  topStartersToday(createdBy: string, now: Date = new Date(), limit = 3): Promise<AutomateQuotaTopStarter[]> {
    return this.model.topStartersByCreatorSince(createdBy, startOfUtcDay(now), limit)
  }

  /**
   * Gate for AutomateRunner.executeAction. A refusal does not count as a
   * failure of the starter: it is the subscriber's budget, not a broken
   * automation, and auto-disabling a sound starter would punish the user twice.
   */
  async check(starter: AutomateStarter, now: Date = new Date()): Promise<AutomateGateResult> {
    if (!starter.createdBy) return { allowed: true }
    let status: AutomateQuotaStatus
    try {
      status = await this.getStatus(starter.createdBy, now)
    } catch (err) {
      console.warn('[AutomateQuota] lookup error (allowing):', err instanceof Error ? err.message : err)
      return { allowed: true }
    }
    if (!status.exhausted) return { allowed: true }

    await this.notifyIfFirstRefusal(starter, status, now)

    const resetHuman = status.resetsAt.slice(11, 16)
    return {
      allowed: false,
      countsAsFailure: false,
      reason:
        `${AUTOMATE_QUOTA_REASON}: ${status.used}/${status.limit} Automate executions used today ` +
        `(${status.planName} plan, resets at ${resetHuman} UTC). Upgrade the plan or space out the triggers.`,
    }
  }

  /**
   * The runner records this refusal right after `check` returns, so "no
   * refused row yet today" means this is the first one: notify once.
   */
  private async notifyIfFirstRefusal(starter: AutomateStarter, status: AutomateQuotaStatus, now: Date): Promise<void> {
    if (!this.onExhausted) return
    try {
      const refusedBefore = await this.model.countRefusedByCreatorSince(starter.createdBy, startOfUtcDay(now))
      if (refusedBefore > 0) return
      const topStarters = await this.topStartersToday(starter.createdBy, now)
      await this.onExhausted(starter, {
        ...status,
        userId: starter.createdBy,
        starterId: starter.starterId,
        starterName: starter.name,
        workspaceId: starter.workspaceId,
        topStarters,
      })
      console.log(`[AutomateQuota] daily budget exhausted for ${starter.createdBy} (${status.used}/${status.limit}, ${status.planName}) — notice sent`)
    } catch (err) {
      console.error('[AutomateQuota] exhaustion notice failed:', err instanceof Error ? err.message : err)
    }
  }
}
