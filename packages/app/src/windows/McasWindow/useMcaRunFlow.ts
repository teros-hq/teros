/**
 * Single-tool run engine for the MCA Health dashboard (Task 1, plan 03/05): executes one tool via
 * `testMcaTool`, overwrites its live result row in place (D-06), and write-throughs the outcome
 * (status + short error only, T-08-03-03) so a reload rehydrates the real reason. A per-tool catch
 * keeps siblings interactive (SC4). A typed `NOT_INSTALLED` throw routes into the non-runnable path
 * (marks the MCA non-runnable so Retest disables + the install-to-test reason renders) and writes no
 * outcome; any other throw becomes a fail row + write-through. Split from `useMcaHealthRunner` so the
 * run engine is its own cohesive slice under the CLAUDE.md line/complexity limits.
 */
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { McaToolResult, ToolTestStatus } from "./mcaStatus.types"
import { resultToRow, toolKey } from "./mcaHealth.utils"

type HealthWrite = { mcaId: string; tool: string; status: ToolTestStatus; error?: string }

export interface McaRunFlow {
  /** `mcaId::tool` keys currently in-flight (spinner + disabled Retest). */
  runningTools: Set<string>
  /** Completed live results by the same key; overwrites the persisted/catalog row in place (D-06). */
  liveResults: Map<string, McaToolResult>
  /** Run one tool, surface + persist its outcome. Never throws (per-tool catch, SC4). */
  runSingleTool: (mcaId: string, tool: string, input?: Record<string, unknown>) => Promise<void>
}

export function useMcaRunFlow(markNotInstalled: (mcaId: string) => void): McaRunFlow {
  const { t } = useTranslation()
  const client = getTerosClient()

  const [runningTools, setRunningTools] = useState<Set<string>>(new Set())
  const [liveResults, setLiveResults] = useState<Map<string, McaToolResult>>(new Map())

  // A failed write is swallowed (D-07): liveResults already reflects the outcome; next load re-reads.
  const writeHealth = useCallback(
    async (results: HealthWrite[]) => {
      if (results.length === 0) return
      try {
        await client.app.recordMcaHealth(results)
      } catch {
        // Non-fatal (D-07).
      }
    },
    [client],
  )

  const applyRunError = useCallback(
    (err: unknown, mcaId: string, tool: string) => {
      if ((err as { code?: string })?.code === "NOT_INSTALLED") {
        markNotInstalled(mcaId)
        return
      }
      const message = err instanceof Error ? err.message : t("mca.status.run.failed")
      setLiveResults((prev) =>
        new Map(prev).set(toolKey(mcaId, tool), {
          tool,
          status: "fail",
          notes: t("mca.status.run.error", { message }),
        }),
      )
      void writeHealth([{ mcaId, tool, status: "fail", error: message }])
    },
    [t, writeHealth, markNotInstalled],
  )

  const runSingleTool = useCallback(
    async (mcaId: string, tool: string, input?: Record<string, unknown>) => {
      const key = toolKey(mcaId, tool)
      setRunningTools((prev) => new Set(prev).add(key))
      try {
        const res = await client.app.testMcaTool(mcaId, tool, input)
        const { row, shortError } = resultToRow(res, tool, t)
        setLiveResults((prev) => new Map(prev).set(key, row))
        const error = row.status === "fail" ? shortError : undefined
        void writeHealth([{ mcaId, tool, status: row.status, error }])
      } catch (err) {
        applyRunError(err, mcaId, tool)
      } finally {
        setRunningTools((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [client, t, writeHealth, applyRunError],
  )

  return { runningTools, liveResults, runSingleTool }
}
