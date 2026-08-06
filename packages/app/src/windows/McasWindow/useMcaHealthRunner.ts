/**
 * Composes the live-test execution surface of the MCA Health dashboard (Tasks 1–3, plan 03/05) from
 * three cohesive slices, each its own function under the CLAUDE.md line/complexity limits:
 *   - `useMcaLazyCaches`  — lazy per-mcaId schema + resolvability caches (D-12).
 *   - `useMcaRunFlow`     — single-tool run engine + write-through persistence (Task 1 / D-06/D-07).
 *   - `useMcaFormFlow`    — awaitable input-Sheet flow (Task 2 / plan 05).
 *   - `useMcaWholeRun`    — whole-MCA sequential runner + destructive-confirm gate (plan 03).
 * Kept out of the render component so the dashboard is display + filtering only. All copy is
 * i18n-driven; this hook takes no display strings of its own.
 */
import type { McaData, McaResolvability } from "../../services/AppApi"
import type { McaToolResult } from "./mcaStatus.types"
import type { ActiveForm } from "./mcaHealth.utils"
import { useMcaFormFlow } from "./useMcaFormFlow"
import { useMcaLazyCaches } from "./useMcaLazyCaches"
import { useMcaRunFlow } from "./useMcaRunFlow"
import { useMcaWholeRun } from "./useMcaWholeRun"

export interface McaHealthRunner {
  runningTools: Set<string>
  liveResults: Map<string, McaToolResult>
  resolvabilityCache: Map<string, McaResolvability>
  runningMcas: Set<string>
  activeForm: ActiveForm | null
  formValues: Record<string, unknown>
  setFormValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
  rawJson: string
  setRawJson: (v: string) => void
  pendingDestructive: { mcaId: string; tools: string[] } | null
  onRetestPress: (mcaId: string, tool: string) => Promise<void>
  runWholeMca: (mcaId: string) => Promise<void>
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>
  closeForm: () => void
  submitForm: () => Promise<void>
  confirmDestructive: () => Promise<void>
  cancelDestructive: () => void
}

export function useMcaHealthRunner(mcas: McaData[]): McaHealthRunner {
  const { resolvabilityCache, ensureResolvability, ensureSchemas, markNotInstalled } =
    useMcaLazyCaches()
  const run = useMcaRunFlow(markNotInstalled)
  const form = useMcaFormFlow(run.runSingleTool, ensureResolvability, ensureSchemas)
  const whole = useMcaWholeRun(
    mcas,
    form.onRetestPress,
    resolvabilityCache,
    ensureResolvability,
    ensureSchemas,
  )

  return {
    runningTools: run.runningTools,
    liveResults: run.liveResults,
    resolvabilityCache,
    runningMcas: whole.runningMcas,
    activeForm: form.activeForm,
    formValues: form.formValues,
    setFormValues: form.setFormValues,
    rawJson: form.rawJson,
    setRawJson: form.setRawJson,
    pendingDestructive: whole.pendingDestructive,
    // The button entry is the gated single-tool Retest (routes destructive tools through the
    // shared confirm). The whole-MCA runner still drives the loop with the raw form.onRetestPress
    // it was constructed with, so confirmed tools are not re-gated.
    onRetestPress: whole.retestSingle,
    runWholeMca: whole.runWholeMca,
    ensureResolvability,
    closeForm: form.closeForm,
    submitForm: form.submitForm,
    confirmDestructive: whole.confirmDestructive,
    cancelDestructive: whole.cancelDestructive,
  }
}
