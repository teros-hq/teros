/**
 * Pricing update (Álvaro's plan structure, 2026-10-09):
 *
 *   Free     0€   2h   (was: Starter 0€/10h, postBeta €9)
 *   Starter  19€  8h   (NEW — paid entry tier)
 *   Growth   89€  40h  (unchanged)
 *   Pro      159€ 80h  (was: 179€)
 *   Ultra    349€ 200h (unchanged)
 *
 * This migration performs a full rename of plan IDs:
 *   plan_starter → plan_seed (Free tier, 0€/2h)
 *   plan_starter_paid → plan_starter (Starter tier, €19/8h)
 *
 * MongoDB does not allow updating _id in place, so we delete + insert.
 * All references in billing_subscriptions, billing_teams, billing_customers
 * are updated accordingly.
 *
 * plan_unlimited is retired: subscriptions are migrated to plan_pro and the
 * plan document is deleted.
 */

import type { Db } from 'mongodb'
import type { Migration } from './types.js'

interface BillingPlanDoc {
  _id: string
  name: string
  displayName: string
  description: string
  price: number
  currency: string
  agentHoursLimit: number
  features: Record<string, unknown>
  isPublic: boolean
  postBetaPrice?: number
  highlights?: string[]
  popular?: boolean
  contactSales?: boolean
  createdAt: Date
  updatedAt: Date
}

const migration: Migration = {
  description:
    'Rename plan IDs (plan_starter→plan_seed, plan_starter_paid→plan_starter), ' +
    'update plan_pro price 179→159, retire plan_unlimited→plan_pro. ' +
    'Matching the new public pricing (Álvaro, 2026-10-09).',

  async up(db: Db): Promise<void> {
    const plans = db.collection<BillingPlanDoc>('billing_plans')
    const subscriptions = db.collection('billing_subscriptions')
    const teams = db.collection('billing_teams')
    const customers = db.collection('billing_customers')
    const now = new Date()

    // ── 1. Rename plan_starter → plan_seed (Free tier) ─────────────────────
    const starterPlan = await plans.findOne({ _id: 'plan_starter' })
    const existingSeed = await plans.findOne({ _id: 'plan_seed' })
    
    if (starterPlan && !existingSeed) {
      // Normal case: plan_starter exists, plan_seed doesn't → rename
      await plans.deleteOne({ _id: 'plan_starter' })
      await plans.insertOne({
        ...starterPlan,
        _id: 'plan_seed',
        name: 'seed',
        displayName: 'Free',
        description: 'Try Teros with no commitment. 2 agent-hours/month.',
        price: 0,
        agentHoursLimit: 2,
        highlights: [
          '2 agent-hours / month',
          'Unlimited integrations, agents & workspaces',
          'On-demand containers',
          'Bring your own AI key',
          'Email support',
        ],
        updatedAt: now,
      })
      console.log('[Migration] plan_starter → plan_seed (Free)')
    } else if (existingSeed) {
      // plan_seed already exists (seed ran before migration) → just update it
      await plans.updateOne(
        { _id: 'plan_seed' },
        {
          $set: {
            name: 'seed',
            displayName: 'Free',
            description: 'Try Teros with no commitment. 2 agent-hours/month.',
            price: 0,
            agentHoursLimit: 2,
            highlights: [
              '2 agent-hours / month',
              'Unlimited integrations, agents & workspaces',
              'On-demand containers',
              'Bring your own AI key',
              'Email support',
            ],
            updatedAt: now,
          },
          $unset: { postBetaPrice: '' },
        },
      )
      console.log('[Migration] plan_seed already exists, updated to Free')
      
      // Clean up plan_starter only if it is the OLD free plan (same shape check as step 2).
      // On a fresh DB the boot seed already wrote the NEW paid plan_starter (€19/8h) next
      // to plan_seed — deleting it here left new environments without the Starter tier.
      if (starterPlan && (starterPlan.postBetaPrice !== undefined || starterPlan.agentHoursLimit !== 8)) {
        await plans.deleteOne({ _id: 'plan_starter' })
        console.log('[Migration] plan_starter deleted (already renamed)')
      }
    }

    // ── 2. Rename plan_starter_paid → plan_starter (Starter tier) ──────────
    const starterPaidPlan = await plans.findOne({ _id: 'plan_starter_paid' })
    const existingStarter = await plans.findOne({ _id: 'plan_starter' })
    
    if (starterPaidPlan && !existingStarter) {
      // Normal case: plan_starter_paid exists, plan_starter doesn't → rename
      await plans.deleteOne({ _id: 'plan_starter_paid' })
      await plans.insertOne({
        ...starterPaidPlan,
        _id: 'plan_starter',
        name: 'starter',
        updatedAt: now,
      })
      console.log('[Migration] plan_starter_paid → plan_starter (Starter)')
    } else if (existingStarter && starterPaidPlan) {
      // Both exist — plan_starter is the old free plan, plan_starter_paid is the new paid
      // Delete the old free plan_starter, rename paid to starter
      await plans.deleteOne({ _id: 'plan_starter' })
      await plans.deleteOne({ _id: 'plan_starter_paid' })
      await plans.insertOne({
        ...starterPaidPlan,
        _id: 'plan_starter',
        name: 'starter',
        updatedAt: now,
      })
      console.log('[Migration] plan_starter (old free) deleted, plan_starter_paid → plan_starter')
    } else if (existingStarter && !starterPaidPlan) {
      // plan_starter exists but it's the OLD free plan (not the new paid one)
      // Check if it's the old free plan (has postBetaPrice or agentHoursLimit !== 8)
      if (existingStarter.postBetaPrice !== undefined || existingStarter.agentHoursLimit !== 8) {
        await plans.deleteOne({ _id: 'plan_starter' })
        console.log('[Migration] plan_starter (old free) deleted, no paid plan to rename')
      }
    }

    // ── 3. Update plan_pro price 179 → 159 ─────────────────────────────────
    const proRes = await plans.updateOne(
      { _id: 'plan_pro' },
      {
        $set: {
          price: 159,
          description: 'For teams working with multiple agents. 80 agent-hours/month.',
          updatedAt: now,
        },
      },
    )
    console.log(`[Migration] plan_pro price 179→159: ${proRes.modifiedCount} updated`)

    // ── 4. Update all references ───────────────────────────────────────────
    // billing_subscriptions
    const subSeed = await subscriptions.updateMany(
      { planId: 'plan_starter' },
      { $set: { planId: 'plan_seed' } },
    )
    console.log(`[Migration] billing_subscriptions plan_starter→plan_seed: ${subSeed.modifiedCount}`)

    const subStarter = await subscriptions.updateMany(
      { planId: 'plan_starter_paid' },
      { $set: { planId: 'plan_starter' } },
    )
    console.log(`[Migration] billing_subscriptions plan_starter_paid→plan_starter: ${subStarter.modifiedCount}`)

    // billing_teams
    const teamSeed = await teams.updateMany(
      { planId: 'plan_starter' },
      { $set: { planId: 'plan_seed' } },
    )
    console.log(`[Migration] billing_teams plan_starter→plan_seed: ${teamSeed.modifiedCount}`)

    const teamStarter = await teams.updateMany(
      { planId: 'plan_starter_paid' },
      { $set: { planId: 'plan_starter' } },
    )
    console.log(`[Migration] billing_teams plan_starter_paid→plan_starter: ${teamStarter.modifiedCount}`)

    // billing_customers
    const custSeed = await customers.updateMany(
      { planId: 'plan_starter' },
      { $set: { planId: 'plan_seed' } },
    )
    console.log(`[Migration] billing_customers plan_starter→plan_seed: ${custSeed.modifiedCount}`)

    const custStarter = await customers.updateMany(
      { planId: 'plan_starter_paid' },
      { $set: { planId: 'plan_starter' } },
    )
    console.log(`[Migration] billing_customers plan_starter_paid→plan_starter: ${custStarter.modifiedCount}`)

    // ── 5. Retire plan_unlimited → migrate subs to plan_pro ────────────────
    const unlimitedSubs = await subscriptions.updateMany(
      { planId: 'plan_unlimited' },
      { $set: { planId: 'plan_pro', updatedAt: now } },
    )
    console.log(`[Migration] plan_unlimited → plan_pro: ${unlimitedSubs.modifiedCount} subscriptions migrated`)

    const unlimitedTeams = await teams.updateMany(
      { planId: 'plan_unlimited' },
      { $set: { planId: 'plan_pro', updatedAt: now } },
    )
    console.log(`[Migration] plan_unlimited → plan_pro (teams): ${unlimitedTeams.modifiedCount} migrated`)

    // Delete the plan document
    const delUnlimited = await plans.deleteOne({ _id: 'plan_unlimited' })
    console.log(`[Migration] plan_unlimited deleted: ${delUnlimited.deletedCount}`)

    // ── 6. Delete plan_essential if it exists (legacy, unused) ─────────────
    const delEssential = await plans.deleteOne({ _id: 'plan_essential' })
    if (delEssential.deletedCount > 0) {
      console.log(`[Migration] plan_essential deleted: ${delEssential.deletedCount}`)
      // Clean up any orphaned subscriptions
      const orphanSubs = await subscriptions.deleteMany({ planId: 'plan_essential' })
      console.log(`[Migration] plan_essential orphaned subscriptions deleted: ${orphanSubs.deletedCount}`)
    }
  },

  async down(db: Db): Promise<void> {
    const plans = db.collection<BillingPlanDoc>('billing_plans')
    const subscriptions = db.collection('billing_subscriptions')
    const teams = db.collection('billing_teams')
    const customers = db.collection('billing_customers')
    const now = new Date()

    // Reverse the renames
    const seedPlan = await plans.findOne({ _id: 'plan_seed' })
    if (seedPlan) {
      await plans.deleteOne({ _id: 'plan_seed' })
      await plans.insertOne({
        ...seedPlan,
        _id: 'plan_starter',
        name: 'starter',
        displayName: 'Starter',
        description: '10 agent-hours/month, bring your own AI key. Free during beta.',
        price: 0,
        postBetaPrice: 9,
        agentHoursLimit: 10,
        highlights: [
          '10 agent-hours / month',
          'Unlimited integrations, agents & workspaces',
          'On-demand containers',
          'Bring your own AI key',
          'Email support',
        ],
        updatedAt: now,
      })
    }

    const starterPlan = await plans.findOne({ _id: 'plan_starter' })
    if (starterPlan && starterPlan.name === 'starter') {
      await plans.deleteOne({ _id: 'plan_starter' })
      await plans.insertOne({
        ...starterPlan,
        _id: 'plan_starter_paid',
        updatedAt: now,
      })
    }

    // Reverse references
    await subscriptions.updateMany({ planId: 'plan_seed' }, { $set: { planId: 'plan_starter' } })
    await subscriptions.updateMany({ planId: 'plan_starter' }, { $set: { planId: 'plan_starter_paid' } })
    await teams.updateMany({ planId: 'plan_seed' }, { $set: { planId: 'plan_starter' } })
    await teams.updateMany({ planId: 'plan_starter' }, { $set: { planId: 'plan_starter_paid' } })
    await customers.updateMany({ planId: 'plan_seed' }, { $set: { planId: 'plan_starter' } })
    await customers.updateMany({ planId: 'plan_starter' }, { $set: { planId: 'plan_starter_paid' } })

    // Restore plan_pro price
    await plans.updateOne(
      { _id: 'plan_pro' },
      { $set: { price: 179, description: '80 agent-hours/month, concurrent agents, SSO and audit logs.', updatedAt: now } },
    )

    // Note: plan_unlimited and plan_essential are NOT restored in down —
    // they were retired intentionally and their data was migrated away.
  },
}

export default migration
