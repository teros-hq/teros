/**
 * Display-local UI state for the MCA Health dashboard: row expansion, category collapse, availability
 * filter chips, and debounced search. Split from `McaStatusDashboard` so the orchestrator stays a
 * thin container under the CLAUDE.md line/complexity limits. The first expand of a row and the Test
 * button both lazily probe resolvability / force-expand so per-tool spinners are visible (D-12).
 */
import { useState } from "react"
import type { McaResolvability } from "../../services/AppApi"
import { useDebouncedValue } from "./useDebouncedValue"
import { type AvailabilityFilters, ALL_VISIBLE } from "./mcaHealth.utils"

export interface McaDashboardControls {
  expandedMcas: Set<string>
  collapsedCategories: Set<string>
  filters: AvailabilityFilters
  rawSearch: string
  setRawSearch: (v: string) => void
  search: string
  toggleMca: (mcaId: string) => void
  toggleCategory: (key: string) => void
  onToggleFilter: (key: keyof AvailabilityFilters) => void
  onTest: (mcaId: string) => void
}

export function useMcaDashboardControls(
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>,
  runWholeMca: (mcaId: string) => Promise<void>,
): McaDashboardControls {
  const [expandedMcas, setExpandedMcas] = useState<Set<string>>(new Set())
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<AvailabilityFilters>(ALL_VISIBLE)
  const [rawSearch, setRawSearch] = useState("")
  const search = useDebouncedValue(rawSearch, 200)

  const toggleMca = (mcaId: string) => {
    // Decide intent BEFORE setState so the side-effect stays out of the updater — updaters must be
    // pure, and StrictMode double-invokes them in dev, which would double-fire ensureResolvability.
    const willExpand = !expandedMcas.has(mcaId)
    setExpandedMcas((prev) => {
      const next = new Set(prev)
      if (next.has(mcaId)) next.delete(mcaId)
      else next.add(mcaId)
      return next
    })
    if (willExpand) void ensureResolvability(mcaId)
  }

  const toggleCategory = (key: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const onToggleFilter = (key: keyof AvailabilityFilters) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const onTest = (mcaId: string) => {
    setExpandedMcas((prev) => (prev.has(mcaId) ? prev : new Set(prev).add(mcaId)))
    void runWholeMca(mcaId)
  }

  return {
    expandedMcas,
    collapsedCategories,
    filters,
    rawSearch,
    setRawSearch,
    search,
    toggleMca,
    toggleCategory,
    onToggleFilter,
    onTest,
  }
}
