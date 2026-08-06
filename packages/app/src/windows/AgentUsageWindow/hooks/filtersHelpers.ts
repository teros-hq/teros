/**
 * Pure helpers backing the `useFilters` hook. Extracted so they can be
 * exercised without a React-rendering test harness.
 */

export type FilterKey =
  | "userId"
  | "agentId"
  | "workspaceId"
  | "provider"
  | "triggerKind"

export interface FilterState {
  userId: string
  agentId: string
  workspaceId: string
  provider: string
  triggerKind: string
}

export const EMPTY_FILTERS: FilterState = {
  userId: "",
  agentId: "",
  workspaceId: "",
  provider: "",
  triggerKind: "",
}

/** `true` if any filter slot has a non-empty value. */
export function isAnyFilterActive(filters: FilterState): boolean {
  return !!(
    filters.userId ||
    filters.agentId ||
    filters.workspaceId ||
    filters.provider ||
    filters.triggerKind
  )
}

/** Pure transition: returns a new state with one slot updated. */
export function withFilter(
  state: FilterState,
  key: FilterKey,
  value: string,
): FilterState {
  return { ...state, [key]: value }
}
