/**
 * Presentational layer for the MCA Health dashboard: summary cards, filter strip, grouped rows, and
 * the input / destructive Sheets. Split from `McaStatusDashboard` so the orchestrator is a thin
 * container and each function stays under the CLAUDE.md line/complexity limits. Holds no state of its
 * own — it renders the `runner` + `controls` + `derived` slices and wires their callbacks.
 */
import { Package } from "@tamagui/lucide-icons"
import { ScrollView, Text, YStack } from "tamagui"
import { CategoryGroup, type McaRowContext } from "./McaRow"
import type { McaRowData } from "./mcaStatus.types"
import { FilterStrip, SummaryCards } from "./McaStatusChrome"
import { DestructiveConfirmSheet, InputFormSheet } from "./McaStatusSheets"
import type { McaDashboardControls } from "./useMcaDashboardControls"
import type { McaDerivedRows } from "./useMcaDerivedRows"
import type { McaHealthRunner } from "./useMcaHealthRunner"

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** Assemble the per-row render context from the runner + display-local controls (D-01/D-12). */
function buildRowContext(
  runner: McaHealthRunner,
  controls: McaDashboardControls,
  locale: string,
  t: Translate,
): McaRowContext {
  return {
    resolvabilityCache: runner.resolvabilityCache,
    liveResults: runner.liveResults,
    runningTools: runner.runningTools,
    runningMcas: runner.runningMcas,
    formOpen: !!runner.activeForm,
    locale,
    expandedMcas: controls.expandedMcas,
    onToggle: controls.toggleMca,
    onTest: controls.onTest,
    onRetestPress: (mcaId, tool) => {
      void runner.onRetestPress(mcaId, tool)
    },
    t,
  }
}

/** The grouped category list, or the empty state when no MCA survives the filters (D-12/D-13). */
function GroupedRows({
  grouped,
  collapsedCategories,
  toggleCategory,
  rowContext,
  t,
}: {
  grouped: Array<{ key: string; label: string; rows: McaRowData[] }>
  collapsedCategories: Set<string>
  toggleCategory: (key: string) => void
  rowContext: McaRowContext
  t: Translate
}) {
  if (grouped.length === 0) {
    return (
      <YStack padding="$6" alignItems="center">
        <Package size={48} color="$gray8" />
        <Text color="$gray10" marginTop="$3" textAlign="center">
          {t("mca.status.empty")}
        </Text>
      </YStack>
    )
  }
  return (
    <YStack gap="$4">
      {grouped.map((group) => (
        <CategoryGroup
          key={group.key}
          group={group}
          collapsed={collapsedCategories.has(group.key)}
          onToggleCategory={toggleCategory}
          ctx={rowContext}
        />
      ))}
    </YStack>
  )
}

/** Full-screen error state (catalog load failure). */
export function DashboardError({ message }: { message: string }) {
  return (
    <YStack
      flex={1}
      backgroundColor="$background"
      justifyContent="center"
      alignItems="center"
      padding="$4"
    >
      <Text color="$red10" textAlign="center">
        {message}
      </Text>
    </YStack>
  )
}

export function McaStatusView({
  runner,
  controls,
  derived,
  locale,
  t,
}: {
  runner: McaHealthRunner
  controls: McaDashboardControls
  derived: McaDerivedRows
  locale: string
  t: Translate
}) {
  const rowContext = buildRowContext(runner, controls, locale, t)
  return (
    <YStack flex={1} backgroundColor="$background">
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          <SummaryCards
            operational={derived.summary.operational}
            failed={derived.summary.failed}
            partial={derived.summary.partial}
            total={derived.summary.total}
            t={t}
          />
          <FilterStrip
            filters={controls.filters}
            onToggle={controls.onToggleFilter}
            rawSearch={controls.rawSearch}
            setRawSearch={controls.setRawSearch}
            t={t}
          />
          <GroupedRows
            grouped={derived.grouped}
            collapsedCategories={controls.collapsedCategories}
            toggleCategory={controls.toggleCategory}
            rowContext={rowContext}
            t={t}
          />
        </YStack>
      </ScrollView>

      <InputFormSheet
        activeForm={runner.activeForm}
        formValues={runner.formValues}
        setFormValues={runner.setFormValues}
        rawJson={runner.rawJson}
        setRawJson={runner.setRawJson}
        onClose={runner.closeForm}
        onSubmit={() => {
          void runner.submitForm()
        }}
        t={t}
      />
      <DestructiveConfirmSheet
        pending={runner.pendingDestructive}
        onConfirm={() => {
          void runner.confirmDestructive()
        }}
        onCancel={runner.cancelDestructive}
        t={t}
      />
    </YStack>
  )
}
