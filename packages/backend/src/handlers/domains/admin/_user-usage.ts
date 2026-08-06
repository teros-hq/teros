/**
 * Per-user quota classification for the admin users panel (TER-682).
 *
 * Pure classification of a user's period usage into buckets the admin can filter
 * by (near the limit, exhausted, boosted, unmetered, no subscription) + a batched
 * index that resolves those buckets over the whole active-subscription set using
 * only `find()`/`toArray()` (so the in-memory test fake exercises the real logic).
 *
 * INVARIANT — no meaning drift vs enforcement: the classification MUST match the
 * billing gate (`billing-gate.assertHoursAvailable`) exactly, so a user shown as
 * "exhausted" is precisely one the gate would block and "unmetered" is precisely
 * the gate's no-op condition:
 *   - unmetered  ⇔ !plan.features.terosModel || baseLimit <= 0        (gate no-op)
 *   - exhausted  ⇔ agentHoursUsed >= effectiveLimit (base + boosts)   (gate throws)
 *   - near       ⇔ >= USAGE_WARNING_THRESHOLD of the SAME effective limit
 * The 80% threshold is imported from the tracker so there is a single source.
 */

import type { Db } from "mongodb"
import {
  type BillingPlan,
  getBillingHourBoostsCollection,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getEffectiveLimit,
} from "../../../models/billing"
import { USAGE_WARNING_THRESHOLD } from "../../../services/agent-hours-tracker"

export type UsageBucket = "near" | "exhausted" | "has_boost" | "unmetered" | "no_sub"

/** Buckets computable from an active subscription (no_sub is the complement). */
export type SubUsageBucket = Exclude<UsageBucket, "no_sub">

export const SUB_USAGE_BUCKETS: readonly SubUsageBucket[] = [
  "near",
  "exhausted",
  "has_boost",
  "unmetered",
]

export const USAGE_BUCKETS: readonly UsageBucket[] = [...SUB_USAGE_BUCKETS, "no_sub"]

export function isUsageBucket(v: unknown): v is UsageBucket {
  return typeof v === "string" && (USAGE_BUCKETS as readonly string[]).includes(v)
}

export interface UserUsage {
  hasSub: boolean
  /** Not enforced: non-Teros plan OR base limit <= 0 (mirrors the billing gate). */
  unmetered: boolean
  /** base (custom ?? plan) + active boosts; 0 when no sub or unmetered base. */
  effectiveLimit: number
  used: number
  boostHours: number
  /** used/effectiveLimit for metered subs; null when unmetered or no sub. */
  pct: number | null
}

export interface UsageComputeInput {
  hasActiveSub: boolean
  /** plan.features.terosModel */
  terosModel: boolean
  /** getEffectiveLimit(sub, plan) = customAgentHoursLimit ?? plan.agentHoursLimit */
  baseLimit: number
  /** Active boost hours in the current window (summed). */
  boostHours: number
  agentHoursUsed: number
}

/** No-sub sentinel usage (avoids null-checks at call sites). */
const NO_SUB_USAGE: UserUsage = {
  hasSub: false,
  unmetered: false,
  effectiveLimit: 0,
  used: 0,
  boostHours: 0,
  pct: null,
}

export function computeUserUsage(input: UsageComputeInput): UserUsage {
  if (!input.hasActiveSub) return NO_SUB_USAGE

  // Mirror billing-gate: boosts only apply to metered Teros plans, so an
  // unmetered sub carries no boost and effectiveLimit <= 0.
  const unmetered = !input.terosModel || input.baseLimit <= 0
  const boostHours = unmetered ? 0 : input.boostHours
  const effectiveLimit = input.baseLimit + boostHours
  const pct = unmetered ? null : input.agentHoursUsed / effectiveLimit
  return {
    hasSub: true,
    unmetered,
    effectiveLimit,
    used: input.agentHoursUsed,
    boostHours,
    pct,
  }
}

export function matchesUsageBucket(u: UserUsage, bucket: UsageBucket): boolean {
  switch (bucket) {
    case "no_sub":
      return !u.hasSub
    case "unmetered":
      return u.hasSub && u.unmetered
    case "has_boost":
      return u.hasSub && u.boostHours > 0
    case "near":
      return u.pct !== null && u.pct >= USAGE_WARNING_THRESHOLD && u.pct < 1
    case "exhausted":
      return u.pct !== null && u.pct >= 1
  }
}

/** Minimal active-sub facts needed for the row badge + hours column. */
export interface SubBadge {
  planId: string
  teamId: string | null
  agentHoursUsed: number
  subId: string
}

export interface UsageIndex {
  /** userId -> usage (active-sub users only). */
  usageByUser: Map<string, UserUsage>
  /** userId -> active-sub facts for badge/enrichment. */
  subByUser: Map<string, SubBadge>
  /** planId -> plan row (for display name resolution). */
  planById: Map<string, BillingPlan>
  /** userIds that have an active subscription. */
  activeSubUserIds: string[]
  /** planId -> userIds on that plan (active sub). */
  planUserIds: Map<string, string[]>
  /** bucket -> userIds (no_sub excluded — it is the complement of activeSubUserIds). */
  bucketUserIds: Record<SubUsageBucket, string[]>
}

/**
 * Batched classification over ALL active subscriptions, using only find()/toArray
 * (three queries total). Scales with the active-sub count, not the whole user
 * base; for very large tenants see the follow-up on TER-681 (indexed aggregation).
 */
export async function buildUsageIndex(db: Db, now: Date): Promise<UsageIndex> {
  const subs = await getBillingSubscriptionsCollection(db).find({ status: "active" }).toArray()

  const planIds = [...new Set(subs.map((s) => s.planId))]
  const plans = planIds.length
    ? await getBillingPlansCollection(db)
        .find({ _id: { $in: planIds } })
        .toArray()
    : []
  const planById = new Map(plans.map((p) => [p._id, p]))

  const subIds = subs.map((s) => s._id)
  // Same window predicate as getActiveBoostHours — do not let it drift.
  const boosts = subIds.length
    ? await getBillingHourBoostsCollection(db)
        .find({
          subscriptionId: { $in: subIds },
          status: "active",
          periodStart: { $lte: now },
          periodEnd: { $gt: now },
        })
        .toArray()
    : []
  const boostBySub = new Map<string, number>()
  for (const b of boosts) {
    boostBySub.set(b.subscriptionId, (boostBySub.get(b.subscriptionId) ?? 0) + b.hours)
  }

  const usageByUser = new Map<string, UserUsage>()
  const subByUser = new Map<string, SubBadge>()
  const activeSubUserIds: string[] = []
  const planUserIds = new Map<string, string[]>()
  const bucketUserIds: Record<SubUsageBucket, string[]> = {
    near: [],
    exhausted: [],
    has_boost: [],
    unmetered: [],
  }

  for (const sub of subs) {
    const plan = planById.get(sub.planId)
    // A sub whose plan row is missing cannot be enforced → treat as unmetered.
    const usage = computeUserUsage({
      hasActiveSub: true,
      terosModel: plan?.features.terosModel ?? false,
      baseLimit: plan ? getEffectiveLimit(sub, plan) : 0,
      boostHours: boostBySub.get(sub._id) ?? 0,
      agentHoursUsed: sub.agentHoursUsed,
    })
    usageByUser.set(sub.userId, usage)
    subByUser.set(sub.userId, {
      planId: sub.planId,
      teamId: sub.teamId ?? null,
      agentHoursUsed: sub.agentHoursUsed,
      subId: sub._id,
    })
    activeSubUserIds.push(sub.userId)
    const onPlan = planUserIds.get(sub.planId) ?? []
    onPlan.push(sub.userId)
    planUserIds.set(sub.planId, onPlan)
    for (const bucket of SUB_USAGE_BUCKETS) {
      if (matchesUsageBucket(usage, bucket)) bucketUserIds[bucket].push(sub.userId)
    }
  }

  return { usageByUser, subByUser, planById, activeSubUserIds, planUserIds, bucketUserIds }
}

/** Row billing shape resolved by the handler (badge + hours column). */
export interface RowBilling {
  planId: string
  planName: string
  status: string
  teamId: string | null
  teamName: string | null
  agentHoursUsed: number
  effectiveLimit: number
  boostHours: number
  /** used/effectiveLimit; null when unmetered. */
  pct: number | null
  unmetered: boolean
}
