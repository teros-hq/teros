/**
 * admin.list-users — Paginated, searchable, filterable list of users (admin only).
 *
 * Returns ONE PAGE of lightweight rows: identity, role/status, providers, apps +
 * conversation counts, 7-day activity, the active plan badge, AND the period
 * quota usage (used / effective limit / pct / boost / unmetered) so the table can
 * render the Hours column and colour it by threshold. The expensive per-user
 * enrichment (agents/workspaces/usage cost, full billing + invoices) is deferred
 * to admin.get-user-detail.
 *
 * Filtering by PLAN or by QUOTA state (near / exhausted / has_boost / unmetered /
 * no_sub) cannot be post-applied to a page without breaking `total`/`summary`, and
 * that state lives in billing_subscriptions (+plans+boosts), not on `users`. So we
 * classify the whole active-subscription set once (buildUsageIndex, find-only so
 * the in-memory test fake exercises it), turn the requested filter into a userId
 * restriction, and let the normal users query paginate + count over it. The KPI
 * summary counts (nearLimit/exhausted) are computed over the user-level scope
 * (status/role/search) so they stay stable pivots regardless of the applied
 * plan/usage filter — hence `summary.total` can differ from the paginated `total`.
 *
 * Cost is bounded: a handful of BATCHED aggregations keyed by the page's userIds
 * plus three find() queries for the classification index.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { UserService } from "../../../auth/user-service"
import { getBillingTeamsCollection } from "../../../models/billing"
import { HandlerError } from "../../../ws-framework/WsRouter"
import {
  buildUsageIndex,
  isUsageBucket,
  type RowBilling,
  type UsageBucket,
  type UsageIndex,
} from "./_user-usage"

interface ListUsersData {
  search?: string
  status?: string
  role?: string
  page?: number
  pageSize?: number
  /** Filter to a single plan id (billing_subscriptions.planId). */
  plan?: string
  /** Filter by quota state of the current period (UsageBucket). */
  usage?: string
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

/** Translate a plan/usage filter into a userId restriction over the index. */
function buildBillingConstraint(
  index: UsageIndex,
  plan: string | undefined,
  usage: UsageBucket | undefined,
): { userIds?: string[]; excludeUserIds?: string[] } {
  let userIds: string[] | undefined
  if (plan) userIds = [...(index.planUserIds.get(plan) ?? [])]

  if (usage === "no_sub") {
    // A plan filter requires an active sub, so plan + no_sub is contradictory.
    if (plan) return { userIds: [] }
    return { excludeUserIds: index.activeSubUserIds }
  }
  if (usage) {
    const bucket = new Set(index.bucketUserIds[usage])
    userIds = userIds ? userIds.filter((id) => bucket.has(id)) : [...index.bucketUserIds[usage]]
  }
  return userIds !== undefined ? { userIds } : {}
}

/** Count a billing-derived bucket within the user-level scope. Skips the query
 *  when the bucket is empty so the common unfiltered path stays cheap. */
async function countBucket(
  userService: UserService,
  scope: { search?: string; status?: string; role?: string },
  bucketIds: string[],
): Promise<number> {
  if (bucketIds.length === 0) return 0
  return userService.countUsers({ ...scope, userIds: bucketIds } as any)
}

/** Resolve a row's billing badge + period quota from the classification index. */
function resolveRowBilling(
  index: UsageIndex,
  userId: string,
  teamById: Map<string, { name: string }>,
): RowBilling | null {
  const sub = index.subByUser.get(userId)
  const usage = index.usageByUser.get(userId)
  if (!sub || !usage) return null
  const plan = index.planById.get(sub.planId)
  const team = sub.teamId ? teamById.get(sub.teamId) : null
  return {
    planId: sub.planId,
    planName: team?.name ?? plan?.displayName ?? plan?.name ?? sub.planId,
    status: "active",
    teamId: sub.teamId,
    teamName: team?.name ?? null,
    agentHoursUsed: usage.used,
    effectiveLimit: usage.effectiveLimit,
    boostHours: usage.boostHours,
    pct: usage.pct,
    unmetered: usage.unmetered,
  }
}

export function createListUsersHandler(userService: UserService, db: Db) {
  return async function listUsers(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== "admin" && user?.role !== "super") {
      throw new HandlerError("FORBIDDEN", "Admin privileges required")
    }

    const data = (rawData ?? {}) as ListUsersData
    const pageSize = Math.min(
      Math.max(1, Math.floor(data.pageSize ?? DEFAULT_PAGE_SIZE)),
      MAX_PAGE_SIZE,
    )
    const page = Math.max(0, Math.floor(data.page ?? 0))
    const search = typeof data.search === "string" ? data.search : undefined
    const status = data.status as any
    const role = data.role as any
    const planFilter = typeof data.plan === "string" && data.plan ? data.plan : undefined
    const usageFilter = isUsageBucket(data.usage) ? data.usage : undefined
    const scope = { search, status, role }

    // Classify every active subscription once — feeds the row Hours column, the
    // plan/usage filter, and the KPI counts.
    const usageIndex = await buildUsageIndex(db, new Date())
    const constraint = buildBillingConstraint(usageIndex, planFilter, usageFilter)

    const [{ users, total }, baseSummary, nearLimit, exhausted] = await Promise.all([
      userService.listUsers({ ...scope, limit: pageSize, skip: page * pageSize, ...constraint }),
      userService.getUserSummary(scope),
      countBucket(userService, scope, usageIndex.bucketUserIds.near),
      countBucket(userService, scope, usageIndex.bucketUserIds.exhausted),
    ])
    const summary = { ...baseSummary, nearLimit, exhausted }

    const ids = users.map((u) => u.userId)

    // 7-day window (YYYY-MM-DD strings) computed once for the whole page.
    const today = new Date()
    const last7Days: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      last7Days.push(d.toISOString().slice(0, 10))
    }
    const since = last7Days[0] + "T00:00:00.000Z"

    // Batched enrichment — one query per concern over the whole page, keyed by userId.
    const [appsAgg, channelsAgg, activityAgg, providersRaw] = await Promise.all([
      ids.length
        ? db
            .collection("apps")
            .aggregate([
              { $match: { ownerId: { $in: ids } } },
              { $group: { _id: "$ownerId", count: { $sum: 1 } } },
            ])
            .toArray()
        : [],
      ids.length
        ? db
            .collection("channels")
            .aggregate([
              { $match: { userId: { $in: ids } } },
              { $group: { _id: "$userId", count: { $sum: 1 } } },
            ])
            .toArray()
        : [],
      ids.length
        ? db
            .collection("channel_messages")
            .aggregate([
              { $match: { userId: { $in: ids }, role: "user", timestamp: { $gte: since } } },
              {
                $group: {
                  _id: { userId: "$userId", day: { $substr: ["$timestamp", 0, 10] } },
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray()
        : [],
      ids.length
        ? db
            .collection("user_providers")
            .find(
              { userId: { $in: ids } },
              { projection: { _id: 0, userId: 1, providerType: 1, displayName: 1, status: 1 } },
            )
            .toArray()
        : [],
    ])

    // Team names for the page's active-sub users (billing already resolved by the index).
    const teamIds = [
      ...new Set(
        ids.map((id) => usageIndex.subByUser.get(id)?.teamId).filter((t): t is string => !!t),
      ),
    ]
    const teams = teamIds.length
      ? await getBillingTeamsCollection(db)
          .find({ _id: { $in: teamIds } })
          .toArray()
      : []
    const teamById = new Map(teams.map((t) => [t._id, { name: t.name }]))

    // Index everything by userId for O(1) assembly.
    const appsByUser = new Map(appsAgg.map((r: any) => [r._id as string, r.count as number]))
    const channelsByUser = new Map(
      channelsAgg.map((r: any) => [r._id as string, r.count as number]),
    )
    const providersByUser = new Map<
      string,
      Array<{ providerType: string; displayName: string; status: string }>
    >()
    for (const p of providersRaw as any[]) {
      const list = providersByUser.get(p.userId) ?? []
      list.push({ providerType: p.providerType, displayName: p.displayName, status: p.status })
      providersByUser.set(p.userId, list)
    }
    const activityByUser = new Map<string, Map<string, number>>()
    for (const r of activityAgg as any[]) {
      const uid = r._id.userId as string
      const day = r._id.day as string
      const m = activityByUser.get(uid) ?? new Map<string, number>()
      m.set(day, r.count as number)
      activityByUser.set(uid, m)
    }

    const enrichedUsers = users.map((u) => {
      const dayCounts = activityByUser.get(u.userId)
      const activity = last7Days.map((date) => ({ date, count: dayCounts?.get(date) ?? 0 }))

      return {
        userId: u.userId,
        profile: u.profile,
        role: u.role,
        status: u.status,
        badges: u.badges ?? [],
        emailVerified: u.emailVerified,
        accessGranted: u.accessGranted ?? false,
        lastLoginAt: u.lastLoginAt?.toISOString(),
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
        providers: providersByUser.get(u.userId) ?? [],
        stats: {
          apps: appsByUser.get(u.userId) ?? 0,
          channels: channelsByUser.get(u.userId) ?? 0,
        },
        activity,
        // Badge + period quota. Full billing + invoices are lazy (get-user-detail).
        billing: resolveRowBilling(usageIndex, u.userId, teamById),
      }
    })

    return {
      users: enrichedUsers,
      total,
      page,
      pageSize,
      summary,
    }
  }
}
