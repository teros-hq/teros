/**
 * Runn API v1 resource shapes (subset of fields we surface).
 *
 * All ids are numeric integers in v1 (v0 used a different format — see the
 * `/legacy-id` endpoint for conversion). Business dates (`startDate`,
 * `endDate`, `date`) are `YYYY-MM-DD` strings; `createdAt`/`updatedAt` are
 * ISO 8601 date-time strings.
 *
 * Source: https://developer.runn.io/openapi/v1.0.0.json
 */

export interface RunnTag {
  id: number
  name: string
}

export interface RunnReference {
  referenceName: string
  externalId: string
}

/** Paginated collection envelope returned by every list endpoint. */
export interface RunnPage<T> {
  values: T[]
  nextCursor: string | null
}

export interface RunnProject {
  id: number
  name: string
  clientId: number
  rateCardId?: number | null
  teamId?: number | null
  isTemplate: boolean
  isArchived: boolean
  isConfirmed: boolean
  pricingModel?: "fp" | "tm" | "nb"
  rateType?: "hours" | "days"
  budget?: number | null
  expensesBudget?: number | null
  tags?: RunnTag[]
  references?: RunnReference[]
  managerIds?: number[]
  createdAt: string
  updatedAt: string
}

export interface RunnPerson {
  id: number
  firstName: string
  lastName: string
  email?: string | null
  isArchived: boolean
  teamId?: number | null
  tags?: RunnTag[]
  references?: RunnReference[]
  holidaysGroupId?: number | null
  managers?: Array<{ id: number }>
  createdAt: string
  updatedAt: string
}

export interface RunnPlaceholder {
  id: number
  firstName: string
  lastName: string
  isArchived: boolean
  tags?: RunnTag[]
  references?: RunnReference[]
  createdAt: string
  updatedAt: string
}

export interface RunnAssignment {
  id: number
  personId: number
  projectId: number
  roleId: number
  startDate: string
  endDate: string
  minutesPerDay: number
  isBillable: boolean
  isPlaceholder: boolean
  isNonWorkingDay: boolean
  isTemplate: boolean
  note?: string | null
  phaseId?: number | null
  workstreamId?: number | null
  createdAt: string
  updatedAt: string
}

export interface RunnActual {
  id: number
  date: string
  personId: number
  projectId: number
  roleId: number
  /** Casing per the Runn spec — one word, lowercase b. */
  billableMinutes: number
  nonbillableMinutes: number
  billableNote?: string | null
  nonbillableNote?: string | null
  phaseId?: number | null
  workstreamId?: number | null
  createdAt: string
  updatedAt: string
}

export interface RunnClient {
  id: number
  name: string
  website?: string | null
  isArchived: boolean
  references?: RunnReference[]
  createdAt: string
  updatedAt: string
}

export interface RunnRole {
  id: number
  name: string | null
  isArchived: boolean
  defaultHourCost?: number
  standardRate?: number
  references?: RunnReference[]
  personIds?: number[]
  createdAt: string
  updatedAt: string
}

export interface RunnTeam {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

export interface RunnSkill {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

/** GET /reports/totals/projects — minute aggregates per project. */
export interface RunnProjectTotals {
  id: number
  /** Note: this report uses `nonBillableMinutes` (capital B), unlike actuals. */
  billableMinutes: number
  nonBillableMinutes: number
  totalMinutes: number
  assignments: { billableMinutes: number; nonBillableMinutes: number; totalMinutes: number }
  actuals: { billableMinutes: number; nonBillableMinutes: number; totalMinutes: number }
}

/** GET /me — the authenticated user. */
export interface RunnMe {
  name: string
}
