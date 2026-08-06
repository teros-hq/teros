/**
 * Field whitelists for curated tool responses.
 *
 * Runn returns flat JSON objects that carry extra payload (customFields,
 * managerIds, personIds, full tag/reference arrays) which inflate the agent's
 * context window. These whitelists define what travels over the wire.
 *
 * Visual / identity fields (name, color via tags, isArchived flags) are kept
 * so the renderer can paint branded rows without a second request.
 *
 * COMPACT variants are for list endpoints; DETAIL variants add heavier payload
 * for single-resource endpoints (get-project, get-person).
 */

// ============================================================================
// PROJECTS
// ============================================================================

export const PROJECT_COMPACT_FIELDS = [
  "id",
  "name",
  "clientId",
  "isArchived",
  "isConfirmed",
  "createdAt",
  "updatedAt",
] as const

export const PROJECT_DETAIL_FIELDS = [
  ...PROJECT_COMPACT_FIELDS,
  "rateCardId",
  "teamId",
  "isTemplate",
  "pricingModel",
  "rateType",
  "budget",
  "expensesBudget",
  "tags",
  "references",
  "managerIds",
] as const

// ============================================================================
// PEOPLE
// ============================================================================

export const PERSON_COMPACT_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "email",
  "isArchived",
  "teamId",
  "createdAt",
  "updatedAt",
] as const

export const PERSON_DETAIL_FIELDS = [
  ...PERSON_COMPACT_FIELDS,
  "tags",
  "references",
  "holidaysGroupId",
  "managers",
] as const

// ============================================================================
// PLACEHOLDERS
// ============================================================================

export const PLACEHOLDER_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "isArchived",
  "tags",
  "references",
  "createdAt",
  "updatedAt",
] as const

// ============================================================================
// ASSIGNMENTS
// ============================================================================

export const ASSIGNMENT_FIELDS = [
  "id",
  "personId",
  "projectId",
  "roleId",
  "startDate",
  "endDate",
  "minutesPerDay",
  "isBillable",
  "isPlaceholder",
  "isNonWorkingDay",
  "note",
  "phaseId",
  "workstreamId",
  "createdAt",
  "updatedAt",
] as const

// ============================================================================
// ACTUALS (timesheets)
// ============================================================================

export const ACTUAL_FIELDS = [
  "id",
  "date",
  "personId",
  "projectId",
  "roleId",
  "billableMinutes",
  "nonbillableMinutes",
  "billableNote",
  "nonbillableNote",
  "phaseId",
  "workstreamId",
  "createdAt",
  "updatedAt",
] as const

// ============================================================================
// CLIENTS
// ============================================================================

export const CLIENT_FIELDS = [
  "id",
  "name",
  "website",
  "isArchived",
  "references",
  "createdAt",
  "updatedAt",
] as const

// ============================================================================
// ROLES
// ============================================================================

export const ROLE_FIELDS = [
  "id",
  "name",
  "isArchived",
  "defaultHourCost",
  "standardRate",
  "references",
  "createdAt",
  "updatedAt",
] as const

// ============================================================================
// TEAMS
// ============================================================================

export const TEAM_FIELDS = ["id", "name", "createdAt", "updatedAt"] as const

// ============================================================================
// SKILLS
// ============================================================================

export const SKILL_FIELDS = ["id", "name", "createdAt", "updatedAt"] as const

// ============================================================================
// PROJECT TOTALS (report)
// ============================================================================

export const PROJECT_TOTALS_FIELDS = [
  "id",
  "billableMinutes",
  "nonBillableMinutes",
  "totalMinutes",
  "assignments",
  "actuals",
] as const

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[]
