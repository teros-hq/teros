/**
 * billing.get-invoices — the caller's OWN invoice history for the profile
 * "Billing" section (status, amount, period, hosted page + PDF links).
 *
 * Most-recent first, capped. Returns DATA only.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { getBillingInvoicesCollection } from '../../../models/billing.js'

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

interface GetInvoicesData {
  limit?: number
}

export function createGetInvoicesHandler(db: Db) {
  return async function getInvoices(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as GetInvoicesData
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.floor(typeof data.limit === 'number' ? data.limit : DEFAULT_LIMIT)),
    )

    const invoices = await getBillingInvoicesCollection(db)
      .find({ userId: ctx.userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()

    return {
      invoices: invoices.map((i) => ({
        id: i._id,
        invoiceNumber: i.invoiceNumber,
        amount: i.amount,
        currency: i.currency,
        status: i.status,
        periodStart: i.periodStart.toISOString(),
        periodEnd: i.periodEnd.toISOString(),
        hostedInvoiceUrl: i.hostedInvoiceUrl ?? null,
        invoicePdfUrl: i.invoicePdfUrl ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
    }
  }
}
