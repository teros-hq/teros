/**
 * `useFilters()` — encapsulates the 5 filter dimensions of the agent-usage
 * dashboard in a single hook.
 *
 * Closes the Shotgun Surgery smell (`Clear filters` previously required 5
 * `setState` calls): now it's `clearAll()` in one line.
 *
 * The hook is a thin wrapper around `useState` + `useCallback`; the pure
 * helpers (`isAnyFilterActive`, `EMPTY_FILTERS`) live in `filtersHelpers.ts`
 * so they can be tested without a DOM (bun:test has no react-testing-library).
 */

import { useCallback, useMemo, useState } from "react"
import {
  EMPTY_FILTERS,
  type FilterKey,
  type FilterState,
  isAnyFilterActive,
} from "./filtersHelpers"

export type { FilterKey, FilterState }

export interface UseFiltersResult {
  filters: FilterState
  setFilter: (key: FilterKey, value: string) => void
  clearAll: () => void
  hasAnyActive: boolean
}

export function useFilters(initial: Partial<FilterState> = {}): UseFiltersResult {
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS, ...initial })

  const setFilter = useCallback((key: FilterKey, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const clearAll = useCallback(() => {
    setFilters(EMPTY_FILTERS)
  }, [])

  const hasAnyActive = useMemo(() => isAnyFilterActive(filters), [filters])

  return { filters, setFilter, clearAll, hasAnyActive }
}
