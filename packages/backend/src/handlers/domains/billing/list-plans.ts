/**
 * billing.list-plans — the public plan catalogue for the onboarding selection
 * screen and the profile plan-change UI.
 *
 * Returns DATA only (the catalogue rows). Public plans (isPublic) ordered by
 * price; the frontend renders the cards (badges, highlights, "Contact sales").
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { getBillingPlansCollection } from '../../../models/billing.js'

export function createListPlansHandler(db: Db) {
  return async function listPlans(_ctx: WsHandlerContext, _rawData: unknown) {
    const plans = await getBillingPlansCollection(db)
      .find({ isPublic: true })
      .toArray()

    // Tier order: self-serve plans by ascending price, contact-sales (Enterprise)
    // always last — Enterprise is €0 in the catalogue and would otherwise sort to
    // the front by price.
    plans.sort(
      (a, b) => Number(a.contactSales ?? false) - Number(b.contactSales ?? false) || a.price - b.price,
    )

    return {
      plans: plans.map((p) => ({
        planId: p._id,
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        price: p.price,
        postBetaPrice: p.postBetaPrice ?? null,
        currency: p.currency,
        agentHoursLimit: p.agentHoursLimit,
        terosModel: p.features.terosModel,
        highlights: p.highlights ?? [],
        popular: p.popular ?? false,
        contactSales: p.contactSales ?? false,
      })),
    }
  }
}
