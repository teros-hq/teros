/**
 * Migration: subscriptions of users with a vaulted card become `stripe`.
 *
 * Until 2026-10-15 only an admin edit set `paymentMethod: 'stripe'` on a
 * subscription; vaulting a card never did. So every self-serve user with a
 * card (prod: 2) kept `manual` renewals that the charge-cron never collects.
 * Flip the ACTIVE subscription of every billing_customers row that has a
 * default payment method. Existing `pending manual` invoices are deliberately
 * left untouched (a business decision: collect, waive or ignore them).
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const migration: Migration = {
  description: 'Billing: active subscriptions of users with a vaulted card switch to paymentMethod stripe',

  async up(db: Db): Promise<void> {
    const userIds = await db
      .collection<{ userId: string; defaultPaymentMethodId: string | null }>('billing_customers')
      .distinct('userId', { defaultPaymentMethodId: { $ne: null } })
    if (userIds.length === 0) {
      console.log('[Migration 20261015_002] no customers with a card — nothing to do')
      return
    }
    const res = await db.collection('billing_subscriptions').updateMany(
      { userId: { $in: userIds }, status: 'active', paymentMethod: { $ne: 'stripe' } },
      { $set: { paymentMethod: 'stripe', updatedAt: new Date() } },
    )
    console.log(`[Migration 20261015_002] ${userIds.length} customers with a card; ${res.modifiedCount} active subscriptions switched to stripe`)
  },
}

export default migration
