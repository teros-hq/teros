/**
 * Admin billing teams handlers
 *
 * Actions:
 *   admin.list-billing-teams    → List all teams with member count
 *   admin.get-team-members      → Resolve a team's members (name, role, plan, usage)
 *   admin.create-billing-team   → Create team with plan, seats, members
 *   admin.update-billing-team   → Change plan, seats, add/remove members, status
 *   admin.delete-billing-team   → Only if no active members
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  addMonthsClampDay,
  getActiveBoostHours,
  getActiveSubscription,
  getBillingPlansCollection,
  getBillingTeamsCollection,
  getBillingSubscriptionsCollection,
  getEffectiveLimit,
  getEffectiveSeatPrice,
  type BillingSubscription,
  type BillingTeam,
} from '../../../models/billing'

/**
 * Validate the optional manual seat-price override at the boundary. JSON Schema
 * does not catch NaN/Infinity, and Number() in the client happily produces them.
 * null/undefined = clear/absent (fall back to the plan price).
 */
function assertSeatPriceOverride(value: number | null | undefined): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HandlerError('INVALID_INPUT', 'customSeatPrice must be a finite number >= 0')
  }
}

// ============================================================================
// LIST BILLING TEAMS
// ============================================================================

export function createListBillingTeamsHandler(userService: UserService, db: Db) {
  return async function listBillingTeams(ctx: WsHandlerContext, _rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const teamsCol = getBillingTeamsCollection(db)
    const plansCol = getBillingPlansCollection(db)

    const teams = await teamsCol.find().sort({ createdAt: -1 }).toArray()
    const plans = await plansCol.find().toArray()
    const planMap = new Map(plans.map((p) => [p._id, p]))

    return {
      teams: teams.map((t) => ({
        _id: t._id,
        name: t.name,
        slug: t.slug,
        planId: t.planId,
        planName: planMap.get(t.planId)?.displayName ?? planMap.get(t.planId)?.name ?? t.planId,
        seatPrice: t.seatPrice,
        customSeatPrice: t.customSeatPrice ?? null,
        seatCount: t.seatCount,
        maxSeats: t.maxSeats,
        status: t.status,
        paymentMethod: t.paymentMethod,
        billingEmail: t.billingEmail,
        memberCount: t.memberIds.length,
        memberIds: t.memberIds,
        ownerId: t.ownerId,
        createdAt: t.createdAt?.toISOString(),
        updatedAt: t.updatedAt?.toISOString(),
      })),
    }
  }
}

// ============================================================================
// CREATE BILLING TEAM
// ============================================================================

interface CreateBillingTeamData {
  name: string
  slug: string
  planId: string
  maxSeats: number
  memberIds?: string[]
  billingEmail?: string
  paymentMethod?: 'stripe' | 'manual' | 'transfer'
  /** Manual per-seat price override (decision E); null/absent = plan price. */
  customSeatPrice?: number | null
}

export function createCreateBillingTeamHandler(userService: UserService, db: Db) {
  return async function createBillingTeam(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = rawData as CreateBillingTeamData
    if (!data.name || !data.slug || !data.planId || !data.maxSeats) {
      throw new HandlerError('MISSING_FIELDS', 'name, slug, planId, and maxSeats are required')
    }
    assertSeatPriceOverride(data.customSeatPrice)

    const plansCol = getBillingPlansCollection(db)
    const teamsCol = getBillingTeamsCollection(db)
    const subsCol = getBillingSubscriptionsCollection(db)

    const plan = await plansCol.findOne({ _id: data.planId })
    if (!plan) {
      throw new HandlerError('INVALID_PLAN', `Plan ${data.planId} not found`)
    }

    // Check slug uniqueness
    const existing = await teamsCol.findOne({ slug: data.slug })
    if (existing) {
      throw new HandlerError('DUPLICATE_SLUG', `Team slug "${data.slug}" already exists`)
    }

    const memberIds = data.memberIds ?? []

    // FK validation: every member must be a real user. Adding a non-existent
    // userId would inflate seatCount and bill a phantom seat (orphan ref).
    for (const memberId of memberIds) {
      const member = await userService.getByUserId(memberId)
      if (!member) {
        throw new HandlerError('INVALID_MEMBER', `User ${memberId} not found`)
      }
    }

    const seatCount = memberIds.length
    const now = new Date()
    const periodEnd = addMonthsClampDay(now, 1)

    const customSeatPrice = data.customSeatPrice ?? null
    const team: BillingTeam = {
      _id: `team_${data.slug}`,
      name: data.name,
      slug: data.slug,
      planId: data.planId,
      // Effective price = manual override (decision E) ?? plan price.
      seatPrice: getEffectiveSeatPrice({ customSeatPrice }, plan),
      customSeatPrice,
      seatCount,
      maxSeats: data.maxSeats,
      status: 'active',
      paymentMethod: data.paymentMethod ?? 'manual',
      billingEmail: data.billingEmail ?? '',
      terosProviderConfigId: null,
      ownerId: ctx.userId,
      memberIds,
      createdAt: now,
      updatedAt: now,
    }

    await teamsCol.insertOne(team)

    // Update member subscriptions to point to this team
    for (const memberId of memberIds) {
      const sub = await getActiveSubscription(db, memberId)
      if (sub) {
        await subsCol.updateOne(
          { _id: sub._id },
          { $set: { teamId: team._id, updatedAt: now } },
        )
      } else {
        // Create a default subscription with teamId
        const newSub = {
          _id: crypto.randomUUID(),
          userId: memberId,
          planId: data.planId,
          teamId: team._id,
          customAgentHoursLimit: null,
          customPrice: null,
          customPriceNote: null,
          agentHoursUsed: 0,
          overageHours: 0,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          status: 'active' as const,
          startDate: now,
          endDate: null,
          paymentMethod: 'manual' as const,
          billingNotes: `Auto-created via team ${team._id}`,
          createdAt: now,
          updatedAt: now,
        }
        await subsCol.insertOne(newSub)
      }
    }

    console.log(`✅ Billing team created: ${team._id} by ${ctx.userId}`)

    return {
      team: {
        _id: team._id,
        name: team.name,
        slug: team.slug,
        planId: team.planId,
        planName: plan.displayName ?? plan.name ?? plan._id,
        seatPrice: team.seatPrice,
        customSeatPrice: team.customSeatPrice ?? null,
        seatCount: team.seatCount,
        maxSeats: team.maxSeats,
        status: team.status,
        paymentMethod: team.paymentMethod,
        billingEmail: team.billingEmail,
        memberCount: team.memberIds.length,
        memberIds: team.memberIds,
        ownerId: team.ownerId,
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
      },
    }
  }
}

// ============================================================================
// UPDATE BILLING TEAM
// ============================================================================

interface UpdateBillingTeamData {
  teamId: string
  name?: string
  planId?: string
  maxSeats?: number
  addMemberIds?: string[]
  removeMemberIds?: string[]
  status?: 'active' | 'paused' | 'cancelled'
  billingEmail?: string
  paymentMethod?: 'stripe' | 'manual' | 'transfer'
  /** Manual per-seat price override (decision E); null clears it (back to plan price). */
  customSeatPrice?: number | null
}

export function createUpdateBillingTeamHandler(userService: UserService, db: Db) {
  return async function updateBillingTeam(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = rawData as UpdateBillingTeamData
    if (!data.teamId) {
      throw new HandlerError('MISSING_FIELDS', 'teamId is required')
    }

    const teamsCol = getBillingTeamsCollection(db)
    const plansCol = getBillingPlansCollection(db)
    const subsCol = getBillingSubscriptionsCollection(db)

    const team = await teamsCol.findOne({ _id: data.teamId })
    if (!team) {
      throw new HandlerError('NOT_FOUND', `Team ${data.teamId} not found`)
    }

    assertSeatPriceOverride(data.customSeatPrice)

    const $set: Record<string, any> = { updatedAt: new Date() }

    // Validate and apply plan change
    const planChanging = data.planId !== undefined && data.planId !== team.planId
    let effPlan = null
    if (planChanging) {
      effPlan = await plansCol.findOne({ _id: data.planId })
      if (!effPlan) {
        throw new HandlerError('INVALID_PLAN', `Plan ${data.planId} not found`)
      }
      $set.planId = data.planId
    }

    // Recompute the effective seat price when the plan OR the override changes
    // (decision E): seatPrice = customSeatPrice ?? plan.price, single source of
    // truth. A plan change preserves an existing override; clearing the override
    // (null) falls back to the plan price.
    if (planChanging || data.customSeatPrice !== undefined) {
      if (!effPlan) effPlan = await plansCol.findOne({ _id: team.planId })
      const customSeatPrice =
        data.customSeatPrice !== undefined ? data.customSeatPrice : team.customSeatPrice ?? null
      if (data.customSeatPrice !== undefined) $set.customSeatPrice = data.customSeatPrice
      $set.seatPrice = getEffectiveSeatPrice({ customSeatPrice }, effPlan ?? { price: team.seatPrice })
    }

    if (data.name !== undefined) $set.name = data.name
    if (data.maxSeats !== undefined) $set.maxSeats = data.maxSeats
    if (data.status !== undefined) $set.status = data.status
    if (data.billingEmail !== undefined) $set.billingEmail = data.billingEmail
    if (data.paymentMethod !== undefined) $set.paymentMethod = data.paymentMethod

    // Handle member additions
    const now = new Date()
    let newMemberIds = [...team.memberIds]

    if (data.addMemberIds && data.addMemberIds.length > 0) {
      for (const memberId of data.addMemberIds) {
        // FK validation: the member must be a real user (no phantom seats).
        const member = await userService.getByUserId(memberId)
        if (!member) {
          throw new HandlerError('INVALID_MEMBER', `User ${memberId} not found`)
        }
        // ...and not already in another team.
        const existingTeam = await teamsCol.findOne({
          _id: { $ne: data.teamId },
          memberIds: memberId,
        })
        if (existingTeam) {
          throw new HandlerError(
            'ALREADY_IN_TEAM',
            `User ${memberId} is already in team ${existingTeam._id}`,
          )
        }
      }

      newMemberIds = [...new Set([...newMemberIds, ...data.addMemberIds])]
      $set.memberIds = newMemberIds
      $set.seatCount = newMemberIds.length

      // Update subscriptions for new members
      for (const memberId of data.addMemberIds) {
        const sub = await getActiveSubscription(db, memberId)
        if (sub) {
          await subsCol.updateOne(
            { _id: sub._id },
            { $set: { teamId: team._id, updatedAt: now } },
          )
        } else {
          const periodEnd = addMonthsClampDay(now, 1)
          await subsCol.insertOne({
            _id: crypto.randomUUID(),
            userId: memberId,
            planId: team.planId,
            teamId: team._id,
            customAgentHoursLimit: null,
            customPrice: null,
            customPriceNote: null,
            agentHoursUsed: 0,
            overageHours: 0,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            status: 'active' as const,
            startDate: now,
            endDate: null,
            paymentMethod: 'manual' as const,
            billingNotes: `Auto-created via team ${team._id}`,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }

    // Handle member removals
    if (data.removeMemberIds && data.removeMemberIds.length > 0) {
      newMemberIds = newMemberIds.filter((id) => !data.removeMemberIds!.includes(id))
      $set.memberIds = newMemberIds
      $set.seatCount = newMemberIds.length

      // Clear teamId from removed members' subscriptions
      for (const memberId of data.removeMemberIds) {
        await subsCol.updateMany(
          { userId: memberId, teamId: team._id },
          { $set: { teamId: null, updatedAt: now } },
        )
      }
    }

    await teamsCol.updateOne({ _id: team._id }, { $set })

    const updatedTeam = await teamsCol.findOne({ _id: team._id })
    const plan = updatedTeam
      ? await plansCol.findOne({ _id: updatedTeam.planId })
      : null

    console.log(`✅ Billing team updated: ${team._id} by ${ctx.userId}`)

    return {
      team: updatedTeam
        ? {
            _id: updatedTeam._id,
            name: updatedTeam.name,
            slug: updatedTeam.slug,
            planId: updatedTeam.planId,
            planName: plan?.displayName ?? plan?.name ?? updatedTeam.planId,
            seatPrice: updatedTeam.seatPrice,
            customSeatPrice: updatedTeam.customSeatPrice ?? null,
            seatCount: updatedTeam.seatCount,
            maxSeats: updatedTeam.maxSeats,
            status: updatedTeam.status,
            paymentMethod: updatedTeam.paymentMethod,
            billingEmail: updatedTeam.billingEmail,
            memberCount: updatedTeam.memberIds.length,
            memberIds: updatedTeam.memberIds,
            ownerId: updatedTeam.ownerId,
            updatedAt: updatedTeam.updatedAt.toISOString(),
          }
        : null,
    }
  }
}

// ============================================================================
// GET TEAM MEMBERS
// ============================================================================

interface GetTeamMembersData {
  teamId: string
}

export function createGetTeamMembersHandler(userService: UserService, db: Db) {
  return async function getTeamMembers(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = (rawData ?? {}) as GetTeamMembersData
    if (!data.teamId) {
      throw new HandlerError('MISSING_FIELDS', 'teamId is required')
    }

    const teamsCol = getBillingTeamsCollection(db)
    const plansCol = getBillingPlansCollection(db)

    const team = await teamsCol.findOne({ _id: data.teamId })
    if (!team) {
      throw new HandlerError('NOT_FOUND', `Team ${data.teamId} not found`)
    }

    const now = new Date()

    // Resolve each member's active subscription once. A member with no active
    // sub (e.g. just added, cron hasn't created one) renders with null usage.
    const subByUser = new Map<string, BillingSubscription | null>()
    await Promise.all(
      team.memberIds.map(async (uid) => {
        subByUser.set(uid, await getActiveSubscription(db, uid))
      }),
    )

    // Resolve plan display names for the members' plans + the team's own plan,
    // in one deduped query.
    const planIds = [
      ...new Set(
        [team.planId, ...[...subByUser.values()].map((s) => s?.planId ?? null)].filter(
          (p): p is string => !!p,
        ),
      ),
    ]
    const plans = planIds.length
      ? await plansCol.find({ _id: { $in: planIds } }).toArray()
      : []
    const planById = new Map(plans.map((p) => [p._id, p]))

    const members = await Promise.all(
      team.memberIds.map(async (uid) => {
        const member = await userService.getByUserId(uid)
        const sub = subByUser.get(uid) ?? null
        const plan = sub ? planById.get(sub.planId) ?? null : null

        // Live usage context (null when the member has no active subscription).
        let planId: string | null = null
        let planName: string | null = null
        let agentHoursUsed: number | null = null
        let agentHoursLimit: number | null = null
        let usagePct: number | null = null
        let subscriptionStatus: string | null = null
        if (sub) {
          const boostHours = await getActiveBoostHours(db, sub._id, now)
          const effectiveLimit = plan
            ? getEffectiveLimit(sub, plan, boostHours)
            : (sub.customAgentHoursLimit ?? 0) + boostHours
          planId = sub.planId
          planName = plan?.displayName ?? plan?.name ?? null
          agentHoursUsed = sub.agentHoursUsed ?? 0
          agentHoursLimit = effectiveLimit
          // Unmetered plans (limit 0 / contact-sales) have no meaningful %.
          usagePct = effectiveLimit > 0 ? Math.round((agentHoursUsed / effectiveLimit) * 100) : null
          subscriptionStatus = sub.status
        }

        return {
          userId: uid,
          userName: member?.profile?.displayName ?? null,
          userEmail: member?.profile?.email ?? null,
          role: member?.role ?? null,
          isOwner: uid === team.ownerId,
          planId,
          planName,
          agentHoursUsed,
          agentHoursLimit,
          usagePct,
          subscriptionStatus,
        }
      }),
    )

    // The owner identity (the future "company admin"), resolved even when the
    // owner is not a member — so the window can show "Owner: X" and scope the
    // company-settings seam to them.
    const ownerUser = team.ownerId ? await userService.getByUserId(team.ownerId) : null
    const owner = ownerUser
      ? {
          userId: ownerUser.userId,
          userName: ownerUser.profile?.displayName ?? null,
          userEmail: ownerUser.profile?.email ?? null,
        }
      : null

    const teamPlan = planById.get(team.planId) ?? null

    return {
      team: {
        _id: team._id,
        name: team.name,
        slug: team.slug,
        planId: team.planId,
        planName: teamPlan?.displayName ?? teamPlan?.name ?? team.planId,
        seatPrice: team.seatPrice,
        customSeatPrice: team.customSeatPrice ?? null,
        seatCount: team.seatCount,
        maxSeats: team.maxSeats,
        status: team.status,
        paymentMethod: team.paymentMethod,
        billingEmail: team.billingEmail,
        ownerId: team.ownerId,
      },
      owner,
      members,
    }
  }
}

// ============================================================================
// DELETE BILLING TEAM
// ============================================================================

interface DeleteBillingTeamData {
  teamId: string
}

export function createDeleteBillingTeamHandler(userService: UserService, db: Db) {
  return async function deleteBillingTeam(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = rawData as DeleteBillingTeamData
    if (!data.teamId) {
      throw new HandlerError('MISSING_FIELDS', 'teamId is required')
    }

    const teamsCol = getBillingTeamsCollection(db)
    const subsCol = getBillingSubscriptionsCollection(db)

    const team = await teamsCol.findOne({ _id: data.teamId })
    if (!team) {
      throw new HandlerError('NOT_FOUND', `Team ${data.teamId} not found`)
    }

    // Only allow deletion if no active members
    if (team.memberIds.length > 0) {
      throw new HandlerError(
        'TEAM_HAS_MEMBERS',
        'Cannot delete team with active members. Remove all members first.',
      )
    }

    // Clear teamId from any subscriptions that still reference it
    await subsCol.updateMany(
      { teamId: team._id },
      { $set: { teamId: null, updatedAt: new Date() } },
    )

    await teamsCol.deleteOne({ _id: team._id })

    console.log(`✅ Billing team deleted: ${team._id} by ${ctx.userId}`)

    return { deleted: true, teamId: data.teamId }
  }
}
