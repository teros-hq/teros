/**
 * Pure derivation layer for the MCA Health dashboard: the memoized row model (`buildRows`), the
 * summary counters (read the FULL catalog, not the filtered view — D-14), and the filtered + grouped
 * list for render. Split from `McaStatusDashboard` so the orchestrator stays a thin container under
 * the CLAUDE.md line/complexity limits.
 */
import { useMemo } from "react"
import type { McaData, McaHealthRecord } from "../../services/AppApi"
import type { McaOverallStatus, McaRowData, McaToolResult } from "./mcaStatus.types"
import {
  type AvailabilityFilters,
  buildRows,
  deriveOverall,
  filterRows,
  groupRows,
  toolKey,
} from "./mcaHealth.utils"

type Translate = (key: string, opts?: Record<string, unknown>) => string

export interface McaDerivedRows {
  summary: { operational: number; failed: number; partial: number; total: number }
  grouped: Array<{ key: string; label: string; rows: McaRowData[] }>
}

/**
 * A row's overall status recomputed against the live results overlay, mirroring `McaRow`'s
 * `effectiveRows` derivation — so the summary counters track live Retest outcomes rather than
 * staying at the persisted load-time values.
 */
function liveOverall(row: McaRowData, liveResults: Map<string, McaToolResult>): McaOverallStatus {
  const effective = row.toolRows.map(
    (tr) => liveResults.get(toolKey(row.mca.mcaId, tr.tool)) ?? tr,
  )
  return deriveOverall(effective)
}

export function useMcaDerivedRows(
  mcas: McaData[],
  persistedHealth: Map<string, McaHealthRecord>,
  filters: AvailabilityFilters,
  search: string,
  t: Translate,
  liveResults: Map<string, McaToolResult>,
): McaDerivedRows {
  const rows = useMemo(() => buildRows(mcas, persistedHealth), [mcas, persistedHealth])
  const summary = useMemo(() => {
    const overalls = rows.map((r) => liveOverall(r, liveResults))
    return {
      operational: overalls.filter((o) => o === "operational").length,
      failed: overalls.filter((o) => o === "failed").length,
      partial: overalls.filter((o) => o === "partial").length,
      total: mcas.length,
    }
  }, [rows, mcas.length, liveResults])
  const grouped = useMemo(
    () => groupRows(filterRows(rows, filters, search), t),
    [rows, filters, search, t],
  )
  return { summary, grouped }
}
