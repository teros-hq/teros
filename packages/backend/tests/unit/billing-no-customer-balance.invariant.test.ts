/**
 * Structural invariant (lint-as-test) — Teros NEVER creates a Stripe customer
 * balance, and the charge guard stays in place (TER-702).
 *
 * Root cause of the €43→€145 incident: the pre-fix upgrade path posted a POSITIVE
 * customer balance transaction; Stripe then swept it into the next finalized
 * invoice (no per-invoice opt-out), inflating the card charge above the quote. In
 * Model B, Teros is the source of truth and must never touch Stripe's customer
 * balance. A grep-based invariant makes the footgun impossible to reintroduce —
 * the build goes red the moment someone adds a balance transaction back, or drops
 * the amount guard from chargeInvoice.
 *
 * PROVEN TO BITE (do not trust a green lint-as-test): each assertion was inverted
 * against the live tree and confirmed red —
 *   - re-adding `createBalanceTransaction(` anywhere in src/ → invariant 1 red,
 *   - deleting the `starting_balance` / `voidInvoice` guard from chargeInvoice →
 *     invariant 2 red.
 * Reverting → green.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')
const STRIPE_SERVICE = join(SRC, 'services', 'stripe-payment-service.ts')

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full))
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('billing — no customer balance, guarded charge (TER-702)', () => {
  it('no source file creates a Stripe customer balance transaction', () => {
    const offenders = collectSourceFiles(SRC).filter((f) =>
      /createBalanceTransaction|createCustomerBalanceTransaction|applyProrationCharge/.test(
        readFileSync(f, 'utf8'),
      ),
    )
    // Model B never uses Stripe's customer balance — a leftover from that path is
    // exactly what swept €89 into a €43 invoice. Keep it impossible by construction.
    expect(offenders.map((f) => f.replace(SRC, ''))).toEqual([])
  })

  it('chargeInvoice keeps the pre-pay amount guard (balance + void)', () => {
    const src = readFileSync(STRIPE_SERVICE, 'utf8')
    // The guard asserts no swept balance and the exact quote, and voids on mismatch
    // so the card is never charged. Removing any piece regresses the incident.
    expect(src).toContain('ref.starting_balance !== 0')
    expect(src).toContain('ref.amount_due !== expected')
    expect(src).toContain('voidInvoice')
  })
})
