import { describe, expect, it } from "bun:test"
import {
  ACTUAL_FIELDS,
  ASSIGNMENT_FIELDS,
  CLIENT_FIELDS,
  PERSON_COMPACT_FIELDS,
  PERSON_DETAIL_FIELDS,
  PLACEHOLDER_FIELDS,
  PROJECT_COMPACT_FIELDS,
  PROJECT_DETAIL_FIELDS,
  PROJECT_TOTALS_FIELDS,
  ROLE_FIELDS,
  SKILL_FIELDS,
  TEAM_FIELDS,
} from "../../src/tools/_fields"

/**
 * These whitelists are the contract between the curated backend output and the
 * renderer. The asserts below pin the Runn-specific shape traps discovered when
 * reading the OpenAPI spec — they bite if someone "fixes" a field name wrongly.
 */
// Helpers widen the `as const` tuples to `readonly string[]` so the matcher
// accepts arbitrary string keys (TS would otherwise infer literal unions).
const has = (list: readonly string[], key: string) => expect(list).toContain(key)
const lacks = (list: readonly string[], key: string) => expect(list).not.toContain(key)
const noDuplicates = (list: readonly string[]) => expect(new Set(list).size).toBe(list.length)

describe("_fields whitelists", () => {
  it("PROJECT_COMPACT keeps identity + client + status flags", () => {
    for (const key of [
      "id",
      "name",
      "clientId",
      "isArchived",
      "isConfirmed",
      "createdAt",
      "updatedAt",
    ]) {
      has(PROJECT_COMPACT_FIELDS, key)
    }
    // Runn uses `isConfirmed`, NOT `confirmed`.
    lacks(PROJECT_COMPACT_FIELDS, "confirmed")
    noDuplicates(PROJECT_COMPACT_FIELDS)
  })

  it("PROJECT_DETAIL extends compact with financials + tags + references", () => {
    for (const key of PROJECT_COMPACT_FIELDS) has(PROJECT_DETAIL_FIELDS, key)
    for (const key of [
      "budget",
      "expensesBudget",
      "pricingModel",
      "rateType",
      "tags",
      "references",
    ]) {
      has(PROJECT_DETAIL_FIELDS, key)
    }
    noDuplicates(PROJECT_DETAIL_FIELDS)
  })

  it("PERSON has firstName/lastName but NOT name or roleId (v1 trap)", () => {
    for (const key of ["id", "firstName", "lastName", "email", "isArchived", "teamId"]) {
      has(PERSON_COMPACT_FIELDS, key)
    }
    // v1 people have no `name` and no `roleId` (role lives in the contract).
    lacks(PERSON_COMPACT_FIELDS, "name")
    lacks(PERSON_COMPACT_FIELDS, "roleId")
    lacks(PERSON_DETAIL_FIELDS, "roleId")
    for (const key of PERSON_COMPACT_FIELDS) has(PERSON_DETAIL_FIELDS, key)
  })

  it("PLACEHOLDER mirrors a light person", () => {
    for (const key of ["id", "firstName", "lastName", "isArchived"]) has(PLACEHOLDER_FIELDS, key)
    noDuplicates(PLACEHOLDER_FIELDS)
  })

  it("ASSIGNMENT uses personId + isPlaceholder, NOT placeholderId", () => {
    for (const key of [
      "id",
      "personId",
      "projectId",
      "roleId",
      "startDate",
      "endDate",
      "minutesPerDay",
      "isBillable",
      "isPlaceholder",
    ]) {
      has(ASSIGNMENT_FIELDS, key)
    }
    // `placeholderId` does not exist on a Runn assignment.
    lacks(ASSIGNMENT_FIELDS, "placeholderId")
  })

  it("ACTUAL uses lowercase `nonbillableMinutes` casing", () => {
    for (const key of [
      "id",
      "date",
      "personId",
      "projectId",
      "roleId",
      "billableMinutes",
      "nonbillableMinutes",
    ]) {
      has(ACTUAL_FIELDS, key)
    }
    // The actuals resource uses one-word lowercase casing.
    lacks(ACTUAL_FIELDS, "nonBillableMinutes")
    lacks(ACTUAL_FIELDS, "note") // split into billableNote / nonbillableNote
  })

  it("PROJECT_TOTALS uses capital-B `nonBillableMinutes` (different casing than actuals)", () => {
    for (const key of [
      "id",
      "billableMinutes",
      "nonBillableMinutes",
      "totalMinutes",
      "assignments",
      "actuals",
    ]) {
      has(PROJECT_TOTALS_FIELDS, key)
    }
    lacks(PROJECT_TOTALS_FIELDS, "nonbillableMinutes")
  })

  it("ROLE exposes cost (defaultHourCost) and rate (standardRate), not `rate`", () => {
    for (const key of ["id", "name", "isArchived", "defaultHourCost", "standardRate"]) {
      has(ROLE_FIELDS, key)
    }
    lacks(ROLE_FIELDS, "rate")
  })

  it("CLIENT, TEAM, SKILL keep their minimal identity shapes", () => {
    for (const key of ["id", "name", "website", "isArchived"]) has(CLIENT_FIELDS, key)
    expect(TEAM_FIELDS).toEqual(["id", "name", "createdAt", "updatedAt"])
    // Team has no `references` (unlike the other resources).
    lacks(TEAM_FIELDS, "references")
    expect(SKILL_FIELDS).toEqual(["id", "name", "createdAt", "updatedAt"])
  })
})
