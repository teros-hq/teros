/**
 * MCA Status taxonomy (Phase 3, DATA-01/02).
 *
 * Spec-defined shape. `McaToolResult` is
 * shaped from the persisted `McaHealthRecord` (app.get-mca-health) at render time and joins to the
 * live catalog by mcaId + tool name; a catalog tool with no persisted record renders `pending`.
 */

// `ToolTestStatus` is the persisted wire status — its canonical home is `@teros/shared`
// (shared by the backend handler). Imported + re-exported here so the window's consumers keep a
// local import path and `services/AppApi` no longer has to reach up into this window module.
import type { ToolTestStatus } from "@teros/shared"
export type { ToolTestStatus }

export type McaOverallStatus = "operational" | "partial" | "failed" | "pending"

export interface McaToolResult {
  tool: string // joins to catalog tools[]
  status: ToolTestStatus
  notes?: string
  /** ISO timestamp of when this tool was last tested (from the persisted McaHealthRecord). */
  testedAt?: string
}

/**
 * A derived per-MCA dashboard row: the live catalog MCA joined to its persisted tool health, with
 * the computed overall status and the latest tool `testedAt`. Built by `buildRows` and rendered by
 * `McaRow`. Imported from AppApi to keep the `mca` shape canonical.
 */
export interface McaRowData {
  mca: import("../../services/AppApi").McaData
  overall: McaOverallStatus
  toolRows: McaToolResult[]
  testedAt?: string
}
