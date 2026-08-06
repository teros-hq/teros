/**
 * MCA Status (Health) window — Phase 4 v2.0 redesign + live-test (HEALTH-01..05, I18N-03).
 *
 * Thin orchestrator. It loads the read-only catalog + persisted health (`useMcaCatalog`), owns the
 * live-test execution surface (`useMcaHealthRunner`), the display-local UI state
 * (`useMcaDashboardControls`), and the pure derivation layer (`useMcaDerivedRows`), then hands them
 * to the presentational `McaStatusView`. Every slice is its own function under the CLAUDE.md
 * line/complexity limits; see each module's header for its responsibility.
 */
import { useTranslation } from "react-i18next"
import { FullscreenLoader } from "../../components/ui"
import { DashboardError, McaStatusView } from "./McaStatusView"
import { useMcaCatalog } from "./useMcaCatalog"
import { useMcaDashboardControls } from "./useMcaDashboardControls"
import { useMcaDerivedRows } from "./useMcaDerivedRows"
import { useMcaHealthRunner } from "./useMcaHealthRunner"

export function McaStatusDashboard() {
  const { t, i18n } = useTranslation()
  const { mcas, persistedHealth, loading, error } = useMcaCatalog()
  const runner = useMcaHealthRunner(mcas)
  const controls = useMcaDashboardControls(runner.ensureResolvability, runner.runWholeMca)
  const derived = useMcaDerivedRows(
    mcas,
    persistedHealth,
    controls.filters,
    controls.search,
    t,
    runner.liveResults,
  )

  if (loading) return <FullscreenLoader variant="default" label={t("common.loading")} />
  if (error) return <DashboardError message={error} />

  return (
    <McaStatusView runner={runner} controls={controls} derived={derived} locale={i18n.language} t={t} />
  )
}
