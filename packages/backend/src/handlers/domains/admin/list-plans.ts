/**
 * admin.list-plans — the FULL billing-plan catalogue for the admin panel.
 *
 * Unlike the user-facing billing.list-plans (which filters isPublic:true for the
 * public pricing catalogue), this returns EVERY plan — including hidden internal
 * tiers like plan_unlimited (isPublic:false) — so an admin can assign them to a
 * user from the BillingPanel. Admin/super only. Returns DATA (ids + resolved
 * fields); the frontend renders the chips and marks the hidden ones.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import { getBillingPlansCollection } from '../../../models/billing.js'

export function createAdminListPlansHandler(userService: UserService, db: Db) {
  return async function adminListPlans(ctx: WsHandlerContext, _rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const plans = await getBillingPlansCollection(db).find({}).toArray()
    // Public tiers first (ascending by price, contact-sales last — mirrors the
    // user-facing order), hidden internal tiers (isPublic:false) appended at the end.
    plans.sort(
      (a, b) =>
        Number(a.isPublic === false) - Number(b.isPublic === false) ||
        Number(a.contactSales ?? false) - Number(b.contactSales ?? false) ||
        a.price - b.price,
    )

    return {
      plans: plans.map((p) => ({
        planId: p._id,
        name: p.name,
        displayName: p.displayName,
        price: p.price,
        currency: p.currency,
        agentHoursLimit: p.agentHoursLimit,
        terosModel: p.features.terosModel,
        isPublic: p.isPublic,
        contactSales: p.contactSales ?? false,
      })),
    }
  }
}
