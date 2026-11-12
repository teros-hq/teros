/**
 * Migration: stamp `automateDailyExecutionLimit` on the billing plans.
 *
 * `seedBillingPlans` only inserts ($setOnInsert), so existing plan documents
 * never pick up a new catalogue field by themselves. This sets the cap on
 * every known plan id from the one shared table in models/billing.ts
 * (Seed 5 · Starter 20 · Growth 50 · Pro 100 · Ultra 200 · Enterprise and
 * Unlimited 0 = unmetered). Plans not in the table are left alone and are
 * treated as unmetered by the gate.
 *
 * Idempotent: a re-run writes the same values. down() unsets the field.
 */

import type { Db } from 'mongodb'
import { AUTOMATE_DAILY_EXECUTION_LIMITS } from '../models/billing.js'
import type { Migration } from './types.js'

const migration: Migration = {
  description: 'Set automateDailyExecutionLimit on billing plans (Automate executions per UTC day, by tier)',

  async up(db: Db): Promise<void> {
    const plans = db.collection<{ _id: string }>('billing_plans')
    const now = new Date()
    for (const [planId, limit] of Object.entries(AUTOMATE_DAILY_EXECUTION_LIMITS)) {
      const res = await plans.updateOne(
        { _id: planId },
        { $set: { automateDailyExecutionLimit: limit, updatedAt: now } },
      )
      console.log(
        `[Migration 20261015_001] ${planId}: automateDailyExecutionLimit=${limit} ` +
          (res.matchedCount ? '(set)' : '(plan not present — skipped)'),
      )
    }
  },

  async down(db: Db): Promise<void> {
    const res = await db
      .collection('billing_plans')
      .updateMany({}, { $unset: { automateDailyExecutionLimit: '' } })
    console.log(`[Migration 20261015_001] rollback: field removed from ${res.modifiedCount} plan(s)`)
  },
}

export default migration
