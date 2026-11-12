/**
 * Document schemas for the critical collections (GOV-2).
 *
 * Single source of truth: the zod objects below.
 * - The backend validates against them on every read and write of these
 *   collections (./validated.ts, applied to the Db in src/index.ts): reads
 *   log a warning and continue; writes warn or fail depending on
 *   DB_SCHEMA_WRITES (docs/architecture/validacion-esquemas.md).
 * - The `$jsonSchema` validators that migration 20261017_011 installs
 *   (validationLevel 'moderate' + validationAction 'warn': mongod only logs)
 *   are GENERATED from them (./json-schema.ts): a second net for writes that
 *   do not go through the backend.
 *
 * The schemas are deliberately minimal and follow what the code writes today:
 * - Required (non-optional) keys are only the fields that EVERY insert/upsert
 *   path sets.
 * - Types allow every variant that really exists. Dates that are stored both
 *   as ISO strings and as BSON Dates accept both (GOV-3 debt: unify on Date).
 * - Enums only where the set of values is closed in code, legacy values included.
 * - `.passthrough()` everywhere: extra fields are never a violation.
 *
 * Fields that some path writes as `undefined` (serialized as null by the
 * driver) or as null are left out rather than widened field by field.
 *
 * Supported zod subset (anything else throws in the converter): object,
 * string, number, boolean, date, enum, optional, nullable, union, array.
 */

import type { Document } from 'mongodb'
import { z } from 'zod'
import { COLLECTIONS } from './collections'
import { toJsonSchema } from './json-schema'

/** GOV-3: both shapes exist. Converts to bsonType ['date', 'string']. */
const dateOrIso = () => z.union([z.date(), z.string()])
/** An object whose content is not described (bsonType 'object' only). */
const anyObject = () => z.object({}).passthrough()

/**
 * users — written by UserService.createUser (signup + OAuth), the
 * create-user script and the smoke seeds; all set userId, profile.email,
 * status and role.
 */
export const userDocSchema = z
  .object({
    userId: z.string(),
    profile: z.object({ email: z.string() }).passthrough(),
    // 'suspended' is also what account deletion leaves behind (pseudonymized users).
    status: z.enum(['active', 'suspended', 'pending_verification']),
    role: z.enum(['user', 'admin', 'super']),
    emailVerified: z.boolean().optional(),
    accessGranted: z.boolean().optional(),
    privateWorkspaceId: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
    deletedAt: z.date().optional(),
  })
  .passthrough()

/**
 * workspaces — written by WorkspaceService.createWorkspace (shared + private)
 * and migration 20260322_001 (ISO string dates), plus smoke scripts (Date).
 * volumeId is not required: the terminal smoke seed omits it.
 */
export const workspaceDocSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    ownerId: z.string(),
    volumeId: z.string().optional(),
    type: z.enum(['private', 'shared']).optional(),
    status: z.enum(['active', 'archived']),
    settings: anyObject().optional(),
    createdAt: dateOrIso().optional(),
    updatedAt: dateOrIso().optional(),
  })
  .passthrough()

/**
 * billing_plans — every write spreads BILLING_PLANS_SEED (seedBillingPlans,
 * migrations 20260622_002 / 20261009_001); only price is $set afterwards.
 */
export const billingPlanDocSchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    price: z.number(),
    currency: z.string(),
    agentHoursLimit: z.number(),
    automateDailyExecutionLimit: z.number().optional(),
    features: anyObject(),
    isPublic: z.boolean(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  })
  .passthrough()

/**
 * billing_subscriptions — inserted by createDefaultSubscription, the plan
 * change (billing-subscription-ops), billing-reset-cron (cancellation /
 * scheduled downgrade), the admin panel and team handlers.
 */
export const billingSubscriptionDocSchema = z
  .object({
    userId: z.string(),
    planId: z.string(),
    // 'cancelled' is legacy (cancellation now sets cancelAtPeriodEnd); the
    // admin panel can still write it, along with 'paused' and 'past_due'.
    status: z.enum(['active', 'paused', 'cancelled', 'past_due', 'ended']),
    currentPeriodStart: z.date(),
    currentPeriodEnd: z.date(),
    agentHoursUsed: z.number().optional(),
    overageHours: z.number().optional(),
    paymentMethod: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  })
  .passthrough()

/**
 * billing_invoices — the period invoice upserted by billing-reset-cron and the
 * one-off (boost / proration) row upserted by billing-one-off-charge. The
 * one-off path sets no invoiceNumber, so it is not required.
 */
export const billingInvoiceDocSchema = z
  .object({
    subscriptionId: z.string(),
    userId: z.string(),
    // Absent on rows predating migration 20260623_001 (which backfills it).
    kind: z.enum(['subscription', 'boost', 'proration']).optional(),
    periodStart: z.date(),
    periodEnd: z.date(),
    amount: z.number(),
    currency: z.string(),
    status: z.enum(['pending', 'invoiced', 'paid', 'waived', 'overdue', 'uncollectible', 'held', 'refunded']),
    paymentMethod: z.enum(['stripe', 'manual', 'transfer', 'other']).optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  })
  .passthrough()

/** Collection name → zod document schema, in the order the migration applies them. */
export const DOC_SCHEMAS: Record<string, z.AnyZodObject> = {
  [COLLECTIONS.users]: userDocSchema,
  [COLLECTIONS.workspaces]: workspaceDocSchema,
  [COLLECTIONS.billingPlans]: billingPlanDocSchema,
  [COLLECTIONS.billingSubscriptions]: billingSubscriptionDocSchema,
  [COLLECTIONS.billingInvoices]: billingInvoiceDocSchema,
}

/** Collection name → generated `$jsonSchema` (migration 20261017_011). */
export const COLLECTION_SCHEMAS: Record<string, Document> = Object.fromEntries(
  Object.entries(DOC_SCHEMAS).map(([name, schema]) => [name, toJsonSchema(schema)]),
)

export const usersSchema = COLLECTION_SCHEMAS[COLLECTIONS.users]
export const workspacesSchema = COLLECTION_SCHEMAS[COLLECTIONS.workspaces]
export const billingPlansSchema = COLLECTION_SCHEMAS[COLLECTIONS.billingPlans]
export const billingSubscriptionsSchema = COLLECTION_SCHEMAS[COLLECTIONS.billingSubscriptions]
export const billingInvoicesSchema = COLLECTION_SCHEMAS[COLLECTIONS.billingInvoices]
