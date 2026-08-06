/**
 * Shared in-memory fake for the `billing_hour_boosts` collection (FASE 6).
 *
 * Faithful to the exact queries the billing code runs against it:
 *   - getActiveBoostHours:   find({ subscriptionId, status, periodStart:{$lte}, periodEnd:{$gt} }).toArray()
 *   - get-billing-audit:     find({ subscriptionId, status }).sort({createdAt:-1}).toArray()
 *   - billing-reset-cron:    updateMany({ subscriptionId, status, periodEnd:{$lte} }, {$set})
 *   - resolve-access-request: insertOne (unique accessRequestId → E11000 on dup), findOne
 *
 * Backed by the caller's array so a test can assert what was inserted/expired.
 * find() returns COPIES (like the real driver) so a later mutation cannot alter
 * what the caller already read.
 */

import { MongoServerError } from 'mongodb'

function matchBoost(b: any, f: any): boolean {
  if (f.subscriptionId !== undefined && b.subscriptionId !== f.subscriptionId) return false
  if (f.userId !== undefined && b.userId !== f.userId) return false
  if (f.status !== undefined && b.status !== f.status) return false
  if (f.accessRequestId !== undefined && b.accessRequestId !== f.accessRequestId) return false
  if (f.periodStart?.$lte !== undefined && !(b.periodStart <= f.periodStart.$lte)) return false
  if (f.periodEnd?.$gt !== undefined && !(b.periodEnd > f.periodEnd.$gt)) return false
  if (f.periodEnd?.$lte !== undefined && !(b.periodEnd <= f.periodEnd.$lte)) return false
  return true
}

export function boostsCollectionFake(boosts: any[] = []) {
  return {
    find(f: any = {}) {
      const items = boosts.filter((b) => matchBoost(b, f)).map((b) => ({ ...b }))
      return {
        sort: () => ({ async toArray() { return items } }),
        async toArray() { return items },
      }
    },
    async findOne(f: any = {}) {
      const b = boosts.find((x) => matchBoost(x, f))
      return b ? { ...b } : null
    },
    async insertOne(doc: any) {
      if (
        doc.accessRequestId !== undefined &&
        boosts.some((b) => b.accessRequestId === doc.accessRequestId)
      ) {
        const err = new MongoServerError({ message: 'E11000 duplicate key' })
        ;(err as any).code = 11000
        throw err
      }
      boosts.push(doc)
      return { insertedId: doc._id }
    },
    async updateMany(f: any, update: any) {
      let n = 0
      for (const b of boosts) {
        if (matchBoost(b, f)) {
          Object.assign(b, update.$set)
          n++
        }
      }
      return { matchedCount: n, modifiedCount: n }
    },
  }
}
