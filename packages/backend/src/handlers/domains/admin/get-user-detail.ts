/**
 * admin.get-user-detail — Expensive per-user enrichment for the expanded
 * UserCard (admin only).
 *
 * This is the lazy half of the admin users panel: admin.list-users returns
 * lightweight rows for the page, and this handler fills in the costly bits for
 * a SINGLE user when their card is expanded — agents/workspaces counts, total
 * usage cost/tokens, and the full billing object (effective price/limit,
 * custom overrides, team, period) plus the recent invoices.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  getActiveBoostHours,
  getActiveSubscription,
  getBillingPlansCollection,
  getBillingInvoicesCollection,
  getBillingTeamsCollection,
  getEffectiveLimit,
  getEffectivePrice,
} from '../../../models/billing'

interface GetUserDetailData {
  targetUserId: string
}

export function createGetUserDetailHandler(userService: UserService, db: Db) {
  return async function getUserDetail(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { targetUserId } = (rawData ?? {}) as GetUserDetailData
    if (!targetUserId) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId is required')
    }

    const plansCol = getBillingPlansCollection(db)
    const invoicesCol = getBillingInvoicesCollection(db)
    const teamsCol = getBillingTeamsCollection(db)

    const [agentsCount, workspacesCount, usageResult, billingSub, invoices] = await Promise.all([
      db.collection('agents').countDocuments({ ownerId: targetUserId }),
      db.collection('workspaces').countDocuments({ ownerId: targetUserId }),
      db.collection('llm_usage').aggregate([
        { $match: { userId: targetUserId } },
        { $group: { _id: null, totalCost: { $sum: '$costTotal' }, totalTokens: { $sum: '$totalTokens' } } },
      ]).toArray(),
      getActiveSubscription(db, targetUserId),
      invoicesCol.find({ userId: targetUserId }).sort({ periodStart: -1 }).limit(12).toArray(),
    ])

    const totalCost = usageResult[0]?.totalCost ?? 0
    const totalTokens = usageResult[0]?.totalTokens ?? 0

    // Resolve billing info (mirrors the old inline list-users enrichment).
    const billingPlan = billingSub ? await plansCol.findOne({ _id: billingSub.planId }) : null
    const effectivePrice = billingSub && billingPlan ? getEffectivePrice(billingSub, billingPlan) : null
    // Boost-aware effective limit (TER-687): the detail must show the SAME limit
    // the gate enforces + the admin's "Period hours" card reads — base (custom ??
    // plan) + active period boosts. Query boosts only for metered Teros plans, the
    // same short-circuit as billing-gate (a boost adds nothing otherwise).
    const baseLimit = billingSub && billingPlan ? getEffectiveLimit(billingSub, billingPlan) : null
    const boostHours =
      billingSub && billingPlan && billingPlan.features.terosModel && (baseLimit ?? 0) > 0
        ? await getActiveBoostHours(db, billingSub._id, new Date())
        : 0
    const effectiveLimit =
      billingSub && billingPlan ? getEffectiveLimit(billingSub, billingPlan, boostHours) : null

    let teamName: string | null = null
    if (billingSub?.teamId) {
      const team = await teamsCol.findOne({ _id: billingSub.teamId })
      if (team) teamName = team.name
    }

    return {
      userId: targetUserId,
      stats: {
        agents: agentsCount,
        workspaces: workspacesCount,
        totalCost,
        totalTokens,
      },
      billing: billingSub
        ? {
            planId: billingSub.planId,
            planName: teamName ?? (billingPlan?.displayName ?? billingPlan?.name ?? billingSub.planId),
            effectivePrice,
            effectiveLimit,
            boostHours,
            agentHoursUsed: billingSub.agentHoursUsed ?? 0,
            overageHours: billingSub.overageHours ?? 0,
            status: billingSub.status,
            billingStatus: invoices[0]?.status ?? 'waived',
            paymentMethod: billingSub.paymentMethod,
            billingNotes: billingSub.billingNotes,
            customPrice: billingSub.customPrice,
            customPriceNote: billingSub.customPriceNote,
            customAgentHoursLimit: billingSub.customAgentHoursLimit,
            terosProviderConfigId: billingSub.terosProviderConfigId ?? null,
            teamId: billingSub.teamId ?? null,
            teamName,
            currentPeriodStart: billingSub.currentPeriodStart?.toISOString(),
            currentPeriodEnd: billingSub.currentPeriodEnd?.toISOString(),
            invoices: invoices.map((inv: any) => ({
              _id: inv._id?.toString(),
              periodStart: inv.periodStart?.toISOString(),
              periodEnd: inv.periodEnd?.toISOString(),
              amount: inv.amount,
              status: inv.status,
              paymentMethod: inv.paymentMethod,
              invoiceNumber: inv.invoiceNumber,
              notes: inv.notes,
            })),
          }
        : null,
    }
  }
}
