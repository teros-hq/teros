/**
 * Transversal payment-due gate (FASE 9, decisions B/C).
 *
 * getBlockingInvoice / assertAccountNotBlocked decide whether an account is cut
 * off because it has an unpaid invoice past its grace window. This is the gate
 * that — wired at the provider choke point — blocks EVERY provider including BYOK.
 *
 * MUST BITE:
 *   - blocking only on 'uncollectible' (dropping the overdue+past-grace arm) →
 *     the "overdue past grace" test goes green-when-it-should-throw → red here.
 *   - treating an overdue-WITHIN-grace invoice as blocking → the grace test red.
 *   - assertAccountNotBlocked not throwing → the throw assertions red.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import {
  assertAccountNotBlocked,
  getBlockingInvoice,
  PaymentDueError,
} from '../../src/services/billing-gate'

const DAY = 86_400_000

function inv(over: Record<string, any> = {}) {
  return {
    _id: 'inv_1',
    userId: 'u',
    amount: 89,
    currency: 'EUR',
    status: 'overdue',
    hostedInvoiceUrl: 'https://pay.stripe.test/inv_1',
    ...over,
  }
}

function matches(invoice: any, filter: any): boolean {
  if (filter.userId && invoice.userId !== filter.userId) return false
  if (filter.$or) {
    return filter.$or.some((cond: any) => {
      if (invoice.status !== cond.status) return false
      if (cond.gracePeriodEndsAt) {
        const lte = cond.gracePeriodEndsAt.$lte
        return invoice.gracePeriodEndsAt != null && invoice.gracePeriodEndsAt <= lte
      }
      return true
    })
  }
  return true
}

function makeDb(invoices: any[]): Db {
  return {
    collection(name: string) {
      if (name === 'billing_invoices') {
        return {
          async findOne(filter: any) {
            return invoices.find((i) => matches(i, filter)) ?? null
          },
        }
      }
      return null as any
    },
  } as unknown as Db
}

describe('getBlockingInvoice', () => {
  const now = new Date()

  it('returns null when there are no invoices', async () => {
    expect(await getBlockingInvoice(makeDb([]), 'u', now)).toBeNull()
  })

  it('ignores paid / pending invoices', async () => {
    const db = makeDb([inv({ status: 'paid' }), inv({ _id: 'inv_2', status: 'pending' })])
    expect(await getBlockingInvoice(db, 'u', now)).toBeNull()
  })

  it('does NOT block an overdue invoice still within its grace window', async () => {
    const db = makeDb([inv({ status: 'overdue', gracePeriodEndsAt: new Date(now.getTime() + 2 * DAY) })])
    expect(await getBlockingInvoice(db, 'u', now)).toBeNull()
  })

  it('blocks an overdue invoice whose grace window has passed', async () => {
    const db = makeDb([inv({ status: 'overdue', gracePeriodEndsAt: new Date(now.getTime() - DAY) })])
    const blocking = await getBlockingInvoice(db, 'u', now)
    expect(blocking?._id).toBe('inv_1')
  })

  it('blocks an uncollectible invoice (grace already exhausted)', async () => {
    const db = makeDb([inv({ status: 'uncollectible' })])
    const blocking = await getBlockingInvoice(db, 'u', now)
    expect(blocking?._id).toBe('inv_1')
  })

  it('scopes to the user', async () => {
    const db = makeDb([inv({ userId: 'other', status: 'uncollectible' })])
    expect(await getBlockingInvoice(db, 'u', now)).toBeNull()
  })
})

describe('assertAccountNotBlocked', () => {
  it('resolves when there is no blocking invoice', async () => {
    await assertAccountNotBlocked(makeDb([inv({ status: 'paid' })]), 'u')
  })

  it('throws PaymentDueError carrying the invoice data for the widget', async () => {
    const db = makeDb([inv({ status: 'uncollectible', amount: 179, currency: 'USD' })])
    let thrown: unknown
    try {
      await assertAccountNotBlocked(db, 'u')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PaymentDueError)
    const e = thrown as PaymentDueError
    expect(e.code).toBe('PAYMENT_DUE')
    expect(e.amount).toBe(179)
    expect(e.currency).toBe('USD')
    expect(e.hostedInvoiceUrl).toBe('https://pay.stripe.test/inv_1')
  })

  it('throws for an overdue invoice past grace', async () => {
    const db = makeDb([inv({ status: 'overdue', gracePeriodEndsAt: new Date(Date.now() - DAY) })])
    await expect(assertAccountNotBlocked(db, 'u')).rejects.toBeInstanceOf(PaymentDueError)
  })
})
