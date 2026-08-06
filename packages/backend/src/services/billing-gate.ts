/**
 * Billing Gate Service
 *
 * Runtime feature-gating based on user's subscription tier.
 * All checks are read-only — they query billing_subscriptions + billing_plans
 * and return booleans or throw typed errors.
 *

 */

import type { Collection, Db } from "mongodb"
import {
  type BillingInvoice,
  type BillingPlan,
  type BillingSubscription,
  STARTER_PLAN_ID,
  type TerosProviderConfig,
  getActiveBoostHours,
  getActiveSubscription,
  getBillingInvoicesCollection,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getEffectiveLimit,
  getTerosProviderConfigsCollection,
} from "../models/billing.js"
import { HandlerError } from "../ws-framework/WsRouter.js"
import { decrypt } from "../auth/encryption"
import { createLogger } from "../lib/logger.js"
import { secrets } from "../secrets/secrets-manager"

const log = createLogger("BillingGate")

// ============================================================================
// TYPES
// ============================================================================

export interface FeatureGateResult {
  allowed: boolean
  reason?: string
  currentTier?: string
  requiredTier?: string
}

export interface SubscriptionFeatures {
  /** Internal plan slug (plan.name, e.g. "growth") — stable id, not for display. */
  tier: string
  /** Human-readable plan name (plan.displayName, e.g. "Growth") — for UI copy. */
  planName: string
  terosModel: boolean
  byok: boolean
  maxWorkspaces: number
  prioritySupport: boolean
  /** Effective limit = (custom override ?? plan default) + active boost hours. */
  agentHoursLimit: number
  /** Active per-period boost hours included in agentHoursLimit (decision #10). */
  boostHours: number
  agentHoursUsed: number
  /** End of the current billing period (ISO) — when the hours reset. null if unset. */
  currentPeriodEnd: string | null
}

// ============================================================================
// ERRORS
// ============================================================================

/**
 * Thrown when a feature is blocked due to subscription tier.
 * Frontend catches `code === "UPGRADE_REQUIRED"` to show an upgrade CTA.
 */
export class UpgradeRequiredError extends HandlerError {
  constructor(
    public readonly feature: string,
    public readonly currentTier: string,
    public readonly requiredTier: string,
    message: string,
  ) {
    super("UPGRADE_REQUIRED", message)
  }
}

/**
 * Thrown when the user's plan includes the Teros model but they have exhausted
 * their agent-hours allowance for the current period. Hard block (decision #1).
 * Frontend catches `code === "HOURS_EXHAUSTED"` to show a usage/upgrade CTA.
 *
 * NOTE: enforced against agentHoursUsed, which the agent-hours-tracker advances
 * every ~5 min, so a user may exceed the limit by up to one tracker interval
 * before being blocked. Exact live accounting lands in FASE 2 (hour ledger).
 */
export class HoursExhaustedError extends HandlerError {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly tier: string,
    /** Human-readable plan name (displayName) for the block CTA copy. */
    public readonly planName: string = tier,
    /** End of the current period (ISO) — when the hours reset. null if unknown. */
    public readonly periodEnd: string | null = null,
  ) {
    super(
      "HOURS_EXHAUSTED",
      `You have used all ${limit}h of agent time included in your ${planName} plan ` +
        `this period (${used.toFixed(1)}h). Wait for your next cycle, upgrade your ` +
        `plan, or connect your own API key (BYOK) to keep going.`,
    )
  }
}

/**
 * Thrown when the account has an unpaid invoice past its grace window
 * (decisions B/C). A HARD, TRANSVERSAL block: it stops every provider — including
 * BYOK — until the user regularizes, because an unpaid account should not run
 * agents at all, no matter how it pays for the model. We do NOT downgrade the
 * plan (decision B); the tier is preserved so paying the invoice restores access.
 * Frontend catches `code === "PAYMENT_DUE"` to show a "regularize payment" CTA.
 */
export class PaymentDueError extends HandlerError {
  constructor(
    public readonly amount: number,
    public readonly currency: string,
    public readonly hostedInvoiceUrl: string | null,
  ) {
    super(
      "PAYMENT_DUE",
      `Your account has an unpaid invoice past its grace period. Settle the ` +
        `outstanding payment to continue using Teros — your plan is kept so access ` +
        `resumes as soon as the payment goes through.`,
    )
  }
}

/**
 * Thrown when a Teros-model provider was resolved for a user who has NO active
 * subscription (paused / past_due / a legacy account predating billing). Without
 * an active sub there is no metered allowance, so the gate used to no-op and serve
 * the Teros model UNMETERED — free and unlimited (TER-621). A paused account must
 * be cut off from the Teros model, like an unpaid one (decision Antonio,
 * 2026-06-30). Frontend catches `code === "NO_ACTIVE_SUBSCRIPTION"` to show a
 * "reactivate / contact support" CTA. (BYOK is unaffected: this only gates the
 * resolved-as-teros path; an unpaid INVOICE still blocks everything via PaymentDueError.)
 */
export class NoActiveSubscriptionError extends HandlerError {
  constructor() {
    super(
      "NO_ACTIVE_SUBSCRIPTION",
      "Your account has no active subscription, so the Teros model is unavailable. " +
        "Reactivate your plan or contact support to continue.",
    )
  }
}

// ============================================================================
// SERVICE
// ============================================================================

export class BillingGateService {
  private subscriptionsCol: Collection<BillingSubscription>
  private plansCol: Collection<BillingPlan>
  private configsCol: Collection<TerosProviderConfig>

  constructor(private readonly db: Db) {
    this.subscriptionsCol = getBillingSubscriptionsCollection(db)
    this.plansCol = getBillingPlansCollection(db)
    this.configsCol = getTerosProviderConfigsCollection(db)
  }

  // --------------------------------------------------------------------------
  // Core checks
  // --------------------------------------------------------------------------

  /**
   * Returns true if the user's plan allows using the Teros model
   * (i.e. plan.features.terosModel === true).
   */
  async canUseTerosModel(userId: string): Promise<boolean> {
    const plan = await this.getUserPlan(userId)
    if (!plan) return false // No subscription = no Teros model
    return plan.features.terosModel === true
  }

  /**
   * Returns true if the user can create another workspace.
   * Respects plan.features.maxWorkspaces (-1 = unlimited).
   */
  async canCreateWorkspace(
    userId: string,
    db: Db,
  ): Promise<boolean> {
    const plan = await this.getUserPlan(userId)
    if (!plan) return false

    const maxWorkspaces = plan.features.maxWorkspaces
    if (maxWorkspaces === -1) return true // unlimited

    const currentCount = await db
      .collection("workspaces")
      .countDocuments({ ownerId: userId, status: "active" })

    return currentCount < maxWorkspaces
  }

  /**
   * Returns true if the user's plan includes priority support.
   */
  async hasPrioritySupport(userId: string): Promise<boolean> {
    const plan = await this.getUserPlan(userId)
    if (!plan) return false
    return plan.features.prioritySupport === true
  }

  /**
   * Returns true if the user's plan allows BYOK (Bring Your Own Key).
   * Currently always true for all tiers, but kept for completeness.
   */
  async canUseBYOK(userId: string): Promise<boolean> {
    const plan = await this.getUserPlan(userId)
    if (!plan) return true // Default to allowing BYOK if no sub
    return plan.features.byok !== false
  }

  // --------------------------------------------------------------------------
  // Bulk feature query
  // --------------------------------------------------------------------------

  /**
   * Get all feature flags for a user in one query.
   * Useful for frontend initialization or admin panels.
   */
  async getSubscriptionFeatures(userId: string): Promise<SubscriptionFeatures | null> {
    const sub = await getActiveSubscription(this.db, userId)
    if (!sub) return null

    const plan = await this.plansCol.findOne({ _id: sub.planId })
    if (!plan) return null

    // Effective limit = base (custom ?? plan) + active boosts. Only metered
    // Teros plans can carry boosts, so skip the boost query for the common
    // Basic/BYOK case (base limit 0 or no Teros model) — both the gate's
    // no-op guards below treat those as unmetered anyway.
    const baseLimit = getEffectiveLimit(sub, plan)
    const boostHours =
      plan.features.terosModel && baseLimit > 0
        ? await getActiveBoostHours(this.db, sub._id, new Date())
        : 0

    return {
      tier: plan.name,
      planName: plan.displayName,
      terosModel: plan.features.terosModel,
      byok: plan.features.byok,
      maxWorkspaces: plan.features.maxWorkspaces,
      prioritySupport: plan.features.prioritySupport,
      agentHoursLimit: getEffectiveLimit(sub, plan, boostHours),
      boostHours,
      agentHoursUsed: sub.agentHoursUsed,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    }
  }

  // --------------------------------------------------------------------------
  // Assert helpers (throw on denial)
  // --------------------------------------------------------------------------

  /**
   * Throws UpgradeRequiredError if the user cannot use the Teros model.
   */
  async assertTerosModelAllowed(userId: string): Promise<void> {
    const allowed = await this.canUseTerosModel(userId)
    if (allowed) return

    const plan = await this.getUserPlan(userId)
    const currentTier = plan?.displayName ?? "Basic"

    throw new UpgradeRequiredError(
      "teros_model",
      currentTier,
      "Pro",
      `The Teros model is not available on your ${currentTier} plan. ` +
        `Upgrade to Pro to use Teros AI without bringing your own API keys.`,
    )
  }

  /**
   * Throws UpgradeRequiredError if the user cannot create more workspaces.
   */
  async assertWorkspaceAllowed(
    userId: string,
    db: Db,
  ): Promise<void> {
    const plan = await this.getUserPlan(userId)
    const maxWorkspaces = plan?.features.maxWorkspaces ?? -1

    if (maxWorkspaces === -1) return // unlimited

    const currentCount = await db
      .collection("workspaces")
      .countDocuments({ ownerId: userId, status: "active" })

    if (currentCount < maxWorkspaces) return

    const currentTier = plan?.displayName ?? "Basic"
    throw new UpgradeRequiredError(
      "workspaces",
      currentTier,
      currentTier, // Same tier but need to increase limit (or higher tier)
      `You have reached the workspace limit (${maxWorkspaces}) on your ` +
        `${currentTier} plan. Contact support to increase your limit or upgrade.`,
    )
  }

  /**
   * Throws when a Teros-model provider was resolved but the user may not consume:
   *   - NoActiveSubscriptionError if there is NO active subscription (paused /
   *     past_due / legacy) — without a sub there is no metered allowance, so the
   *     old no-op served the Teros model unmetered (TER-621); a paused account is
   *     cut off from the Teros model;
   *   - HoursExhaustedError if the metered allowance for the period is used up.
   *
   * No-op only when the plan does not include the Teros model (the tier gate
   * handles that) or the effective limit is <= 0 (unmetered, e.g. Enterprise).
   * Called for the resolved-as-teros path only, so BYOK is unaffected.
   */
  async assertHoursAvailable(userId: string): Promise<void> {
    const features = await this.getSubscriptionFeatures(userId)
    if (!features) throw new NoActiveSubscriptionError()
    if (!features.terosModel) return

    const limit = features.agentHoursLimit
    if (limit <= 0) return // unmetered / not applicable

    if (features.agentHoursUsed >= limit) {
      throw new HoursExhaustedError(
        features.agentHoursUsed,
        limit,
        features.tier,
        features.planName,
        features.currentPeriodEnd,
      )
    }
  }

  // --------------------------------------------------------------------------
  // Teros provider config resolution
  // --------------------------------------------------------------------------

  /**
   * Get the TerosProviderConfig assigned to a user.
   * 1. If subscription has terosProviderConfigId, fetch that config.
   * 2. If not set or not found, fetch the default config (isDefault: true).
   * 3. If no default exists, return null.
   */
  async getUserTerosProviderConfig(
    userId: string,
  ): Promise<TerosProviderConfig | null> {
    const sub = await getActiveSubscription(this.db, userId)

    // 1. Try assigned config
    if (sub?.terosProviderConfigId) {
      const assigned = await this.configsCol.findOne({
        _id: sub.terosProviderConfigId,
      })
      if (assigned) return assigned
    }

    // 2. Fall back to default
    const defaultConfig = await this.configsCol.findOne({ isDefault: true })
    return defaultConfig ?? null
  }

  // --------------------------------------------------------------------------
  // Provider filtering
  // --------------------------------------------------------------------------

  /**
   * Filters a list of provider types, removing 'teros' if the user's
   * plan does not include the Teros model feature.
   *
   * Used by ProviderService.resolveProviderForAgent to ensure Basic users
   * never resolve to the Teros provider.
   */
  async filterAllowedProviders(
    userId: string,
    providerTypes: string[],
  ): Promise<string[]> {
    const canUseTeros = await this.canUseTerosModel(userId)
    if (canUseTeros) return providerTypes

    return providerTypes.filter((pt) => pt !== "teros")
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Get the BillingPlan document for a user (via their subscription).
   * Returns null if no subscription or no plan found.
   */
  private async getUserPlan(
    userId: string,
  ): Promise<BillingPlan | null> {
    // The active sub (status:'active') only. No active sub — user created before
    // billing, or paused/cancelled/ended — falls back to the Starter entry tier.
    const sub = await getActiveSubscription(this.db, userId)
    if (!sub) {
      return this.plansCol.findOne({ _id: STARTER_PLAN_ID })
    }

    const plan = await this.plansCol.findOne({ _id: sub.planId })
    if (!plan) {
      // Corrupt data: subscription references non-existent plan
      log.warn(
        { subscriptionId: sub._id, planId: sub.planId, userId },
        "Subscription references missing plan; falling back to Starter",
      )
      return this.plansCol.findOne({ _id: STARTER_PLAN_ID })
    }

    return plan
  }
}

// ============================================================================
// Encryption helper for Teros provider configs
// ============================================================================

/** Decrypt a fireworksApiKey stored as data:iv:tag using the system key. */
export function decryptTerosProviderApiKey(combined: string): string {
  const [data, iv, tag] = combined.split(':')
  if (!data || !iv || !tag) {
    throw new Error('Invalid encrypted format for Teros provider API key')
  }
  const encryptionSecret = secrets.requireSystem('encryption')
  const systemKey = Buffer.from(encryptionSecret.masterKey, 'hex')
  return decrypt({ data, iv, tag }, systemKey)
}

// ============================================================================
// Standalone helpers (for use outside the service class)
// ============================================================================

/**
 * Quick check: can this user use the Teros model?
 * Creates a temporary BillingGateService instance.
 */
export async function canUseTerosModel(
  db: Db,
  userId: string,
): Promise<boolean> {
  const gate = new BillingGateService(db)
  return gate.canUseTerosModel(userId)
}

/**
 * Hard gate: throws HoursExhaustedError if a Teros-model user has run out of
 * agent hours this period. Called from the provider resolution choke point
 * once the resolved provider is known to be 'teros'.
 */
export async function assertTerosHoursAvailable(
  db: Db,
  userId: string,
): Promise<void> {
  const gate = new BillingGateService(db)
  return gate.assertHoursAvailable(userId)
}

/**
 * The user's blocking invoice, or null. An invoice blocks when it is
 * 'uncollectible' (dunning grace already exhausted by the charge-cron) OR
 * 'overdue' with its grace window already past (covers the gap between grace
 * expiry and the next charge-cron tick that flips it to uncollectible). An
 * overdue invoice still inside its grace window does NOT block — the user is
 * being retried, not cut off (decision C, 7-day grace).
 */
export async function getBlockingInvoice(
  db: Db,
  userId: string,
  now: Date,
): Promise<BillingInvoice | null> {
  return getBillingInvoicesCollection(db).findOne({
    userId,
    $or: [
      { status: "uncollectible" },
      { status: "overdue", gracePeriodEndsAt: { $lte: now } },
    ],
  })
}

/**
 * Transversal hard gate (decision B): throws PaymentDueError if the account has
 * an unpaid invoice past grace. Called from the provider resolution choke point
 * for EVERY resolved provider — including BYOK — so an unpaid account cannot run
 * agents on any model. Independent of providerType, unlike the teros-hours gate.
 */
export async function assertAccountNotBlocked(
  db: Db,
  userId: string,
): Promise<void> {
  const blocking = await getBlockingInvoice(db, userId, new Date())
  if (!blocking) return
  throw new PaymentDueError(
    blocking.amount,
    blocking.currency,
    blocking.hostedInvoiceUrl ?? null,
  )
}

/**
 * Quick check: can this user create another workspace?
 */
export async function canCreateWorkspace(
  db: Db,
  userId: string,
): Promise<boolean> {
  const gate = new BillingGateService(db)
  return gate.canCreateWorkspace(userId, db)
}

/**
 * Get the TerosProviderConfig assigned to a user (or default).
 * Creates a temporary BillingGateService instance.
 */
export async function getUserTerosProviderConfig(
  db: Db,
  userId: string,
): Promise<TerosProviderConfig | null> {
  const gate = new BillingGateService(db)
  return gate.getUserTerosProviderConfig(userId)
}
