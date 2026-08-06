/**
 * Tests for the pure helpers of `useFilters` (filtersHelpers.ts). The hook
 * itself is a thin wrapper around `useState` + `useCallback` and would need
 * a React-DOM test harness to exercise (not available in this bun:test
 * setup). The helpers cover the actual behavior the user cares about:
 *   - hasAnyActive predicate.
 *   - withFilter immutable transition.
 *   - Empty state shape.
 */

import { describe, expect, it } from "vitest"
import {
  EMPTY_FILTERS,
  isAnyFilterActive,
  withFilter,
  type FilterState,
} from "../hooks/filtersHelpers"

describe("EMPTY_FILTERS", () => {
  it("is a frozen empty state with all 5 slots present", () => {
    expect(EMPTY_FILTERS).toEqual({
      userId: "",
      agentId: "",
      workspaceId: "",
      provider: "",
      triggerKind: "",
    })
  })
})

describe("isAnyFilterActive", () => {
  it("false on empty state", () => {
    expect(isAnyFilterActive(EMPTY_FILTERS)).toBe(false)
  })

  it("true when any single filter has a value", () => {
    expect(isAnyFilterActive({ ...EMPTY_FILTERS, userId: "u_a" })).toBe(true)
    expect(isAnyFilterActive({ ...EMPTY_FILTERS, agentId: "a_x" })).toBe(true)
    expect(isAnyFilterActive({ ...EMPTY_FILTERS, workspaceId: "w_1" })).toBe(true)
    expect(isAnyFilterActive({ ...EMPTY_FILTERS, provider: "anthropic" })).toBe(true)
    expect(isAnyFilterActive({ ...EMPTY_FILTERS, triggerKind: "user_message" })).toBe(true)
  })

  it("true when multiple slots are populated", () => {
    expect(
      isAnyFilterActive({ ...EMPTY_FILTERS, userId: "u", agentId: "a" }),
    ).toBe(true)
  })
})

describe("withFilter", () => {
  it("returns a NEW object (immutability)", () => {
    const result = withFilter(EMPTY_FILTERS, "userId", "u_a")
    expect(result).not.toBe(EMPTY_FILTERS)
  })

  it("only mutates the addressed key", () => {
    const state: FilterState = {
      userId: "u_a",
      agentId: "a_x",
      workspaceId: "",
      provider: "",
      triggerKind: "",
    }
    const next = withFilter(state, "userId", "u_b")
    expect(next).toEqual({ ...state, userId: "u_b" })
    expect(next.agentId).toBe("a_x") // untouched
  })

  it("setting empty string is a valid 'clear single' operation", () => {
    const state: FilterState = { ...EMPTY_FILTERS, provider: "openai" }
    expect(withFilter(state, "provider", "").provider).toBe("")
  })
})
