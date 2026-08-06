/**
 * A single MCA's collapsed health bar + its expanded read-only per-tool table (HEALTH-04 / D-01..07).
 * Split out of the dashboard so the row render stays under the cognitive-complexity limit
 * (CLAUDE.md): the availability chip, the segmented health bar, and each tool row are their own
 * small components. Display + per-row controls only — all run logic lives in useMcaHealthRunner.
 */
import { ChevronDown, ChevronRight, ChevronUp, Package } from "@tamagui/lucide-icons"
import { Button, Separator, Text, XStack, YStack } from "tamagui"
import { AppSpinner } from "../../components/ui"
import type { McaData, McaResolvability } from "../../services/AppApi"
import { Badge } from "./McaStatusBadge"
import {
  STATUS_COLORS,
  classifyAvailabilityTier,
  computeHealth,
  deriveOverall,
  formatTestedAt,
  toolKey,
} from "./mcaHealth.utils"
import type { McaOverallStatus, McaRowData, McaToolResult } from "./mcaStatus.types"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"

type Translate = (key: string, opts?: Record<string, unknown>) => string

const overallLabel = (overall: McaOverallStatus, t: Translate): string => {
  if (overall === "operational") return t("mca.status.summary.operational")
  if (overall === "failed") return t("mca.status.summary.failed")
  if (overall === "partial") return t("mca.status.summary.partial")
  return t("mca.status.toolStatus.pending")
}

/**
 * The availability chip label mirrors the Control window groups (system/hidden/disabled/role).
 * Derived from the shared `classifyAvailabilityTier` so the badge and the filter chips
 * (`filterRows`) agree on an MCA's tier — the tier value is the i18n key suffix.
 */
const availabilityLabel = (mca: McaData, t: Translate): string =>
  t(`mca.status.filters.${classifyAvailabilityTier(mca)}`)

/** Segmented inline health bar + passing/counted fraction (D-04/D-05/D-07). */
function McaHealthBar({
  counted,
  passing,
  confirm,
  fail,
  t,
}: {
  counted: number
  passing: number
  confirm: number
  fail: number
  t: Translate
}) {
  const c = useColors()
  return (
    <XStack flex={1} minWidth={60} alignItems="center" gap="$2">
      <XStack
        flex={1}
        height={8}
        borderRadius="$10"
        overflow="hidden"
        backgroundColor={c.borderStrong}
      >
        {counted === 0 ? (
          // Never tested — single neutral grey segment (D-05).
          <XStack flex={1} backgroundColor={STATUS_COLORS.pending} />
        ) : (
          <>
            {passing > 0 && <XStack flex={passing} backgroundColor={STATUS_COLORS.ok} />}
            {confirm > 0 && <XStack flex={confirm} backgroundColor={STATUS_COLORS.confirm} />}
            {fail > 0 && <XStack flex={fail} backgroundColor={STATUS_COLORS.fail} />}
          </>
        )}
      </XStack>
      <Text fontSize="$1" color={c.text3} fontFamily="$mono" minWidth={48} textAlign="right">
        {counted === 0 ? t("mca.status.healthBar.notTested") : `${passing}/${counted}`}
      </Text>
    </XStack>
  )
}

/** One expanded per-tool row: name + last-tested, status/spinner, notes, Retest (D-01/TEST-01). */
function McaToolRow({
  mcaId,
  tr,
  running,
  nonRunnable,
  formOpen,
  locale,
  onRetestPress,
  t,
}: {
  mcaId: string
  tr: McaToolResult
  running: boolean
  nonRunnable: boolean
  formOpen: boolean
  locale: string
  onRetestPress: (mcaId: string, tool: string) => void
  t: Translate
}) {
  const c = useColors()
  const toolTestedAt = formatTestedAt(tr.testedAt, locale)
  const retestDisabled = running || nonRunnable || formOpen
  return (
    <XStack gap="$3" alignItems="center">
      <YStack flex={2} gap="$0.5">
        <Text fontSize="$2" fontFamily="$mono" color="$color">
          {tr.tool}
        </Text>
        {toolTestedAt ? (
          <Text fontSize="$1" color={c.text3}>
            {t("mca.status.toolTestedAt", { date: toolTestedAt })}
          </Text>
        ) : null}
      </YStack>
      <XStack flex={1} alignItems="center">
        {running ? (
          <AppSpinner size="sm" />
        ) : (
          <Badge color={STATUS_COLORS[tr.status]}>{t(`mca.status.toolStatus.${tr.status}`)}</Badge>
        )}
      </XStack>
      <Text flex={3} fontSize="$2" color={c.text3}>
        {running ? t("mca.status.run.inFlight") : (tr.notes ?? "")}
      </Text>
      <XStack flex={1} justifyContent="flex-end">
        <Button
          size="$2"
          disabled={retestDisabled}
          opacity={retestDisabled ? 0.5 : 1}
          backgroundColor={c.bgCardHover}
          borderWidth={1}
          borderColor={c.borderStrong}
          onPress={() => onRetestPress(mcaId, tr.tool)}
        >
          <Text fontSize="$1" color={c.text2}>
            {t("mca.status.retestTool")}
          </Text>
        </Button>
      </XStack>
    </XStack>
  )
}

/** Expanded body: tested-at line, non-runnable reason, and the Tool/Status/Notes table (D-02). */
function McaToolTable({
  mcaId,
  effectiveRows,
  runningTools,
  nonRunnable,
  formOpen,
  testedAt,
  locale,
  onRetestPress,
  t,
}: {
  mcaId: string
  effectiveRows: McaToolResult[]
  runningTools: Set<string>
  nonRunnable: boolean
  formOpen: boolean
  testedAt?: string
  locale: string
  onRetestPress: (mcaId: string, tool: string) => void
  t: Translate
}) {
  const c = useColors()
  const testedAtLabel = formatTestedAt(testedAt, locale)
  return (
    <YStack padding="$3" paddingTop={0} gap="$3">
      <Separator backgroundColor={c.borderStrong} />
      {testedAtLabel ? (
        <Text fontSize="$1" color={c.text3}>
          {t("mca.status.testedAt", { date: testedAtLabel })}
        </Text>
      ) : null}
      {/* Non-runnable reason (SC5) — MCA can't be tested (D-13/D-14). `reason` is a typed wire code,
          never display text, so always render the localized copy (REQ-16/AC-14). */}
      {nonRunnable && (
        <XStack alignItems="center" gap="$2">
          <Badge color={STATUS_COLORS.pending}>{t("mca.status.nonRunnable.installToTest")}</Badge>
          <Text flex={1} fontSize="$1" color={c.text3}>
            {t("mca.status.nonRunnable.reason")}
          </Text>
        </XStack>
      )}
      {/* Table header (Tool / Status / Notes) */}
      <XStack gap="$3" alignItems="center">
        <Text flex={2} fontSize="$1" fontWeight="700" color={c.text2}>
          {t("mca.status.columns.tool")}
        </Text>
        <Text flex={1} fontSize="$1" fontWeight="700" color={c.text2}>
          {t("mca.status.columns.status")}
        </Text>
        <Text flex={3} fontSize="$1" fontWeight="700" color={c.text2}>
          {t("mca.status.columns.notes")}
        </Text>
        <XStack flex={1} />
      </XStack>
      {effectiveRows.map((tr) => (
        <McaToolRow
          key={tr.tool}
          mcaId={mcaId}
          tr={tr}
          running={runningTools.has(toolKey(mcaId, tr.tool))}
          nonRunnable={nonRunnable}
          formOpen={formOpen}
          locale={locale}
          onRetestPress={onRetestPress}
          t={t}
        />
      ))}
    </YStack>
  )
}

/**
 * Shared render context threaded from the dashboard down to each row (runner state + per-row
 * callbacks + i18n). Bundled into one object so `McaRow`/`CategoryGroup` don't carry a dozen props.
 */
export interface McaRowContext {
  resolvabilityCache: Map<string, McaResolvability>
  liveResults: Map<string, McaToolResult>
  runningTools: Set<string>
  runningMcas: Set<string>
  formOpen: boolean
  locale: string
  expandedMcas: Set<string>
  onToggle: (mcaId: string) => void
  onTest: (mcaId: string) => void
  onRetestPress: (mcaId: string, tool: string) => void
  t: Translate
}

/** The always-visible collapsed bar: icon, name, availability + overall badges, health bar, Test,
 *  chevron (D-01/D-03/D-11). The Test button force-expands the row (via onTest) so per-tool spinners
 *  show, then starts the runner; stopPropagation keeps the bar's own toggle from also firing. */
function McaRowBar({
  mca,
  overall,
  expanded,
  testDisabled,
  health,
  onToggle,
  onTest,
  t,
}: {
  mca: McaData
  overall: McaOverallStatus
  expanded: boolean
  testDisabled: boolean
  health: { counted: number; passing: number; confirm: number; fail: number }
  onToggle: (mcaId: string) => void
  onTest: (mcaId: string) => void
  t: Translate
}) {
  const c = useColors()
  return (
    <XStack
      padding="$3"
      alignItems="center"
      gap="$3"
      cursor="pointer"
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      pressStyle={{ opacity: 0.8 }}
      onPress={() => onToggle(mca.mcaId)}
    >
      <Package size={16} color={c.text3} />
      <Text fontSize="$3" fontWeight="600" color="$color" flexShrink={1} numberOfLines={1}>
        {mca.name}
      </Text>
      <Badge color={STATUS_COLORS[mca.availability.system ? "pending" : overall]}>
        {availabilityLabel(mca, t)}
      </Badge>
      <Badge color={STATUS_COLORS[overall]}>{overallLabel(overall, t)}</Badge>
      <McaHealthBar {...health} t={t} />
      <Button
        size="$2"
        disabled={testDisabled}
        opacity={testDisabled ? 0.5 : 1}
        backgroundColor={semanticColors.indigoGlow}
        borderWidth={1}
        borderColor={semanticColors.indigo}
        onPress={(e) => {
          e.stopPropagation?.()
          onTest(mca.mcaId)
        }}
      >
        <Text fontSize="$1" color={semanticColors.indigo}>
          {t("mca.status.test")}
        </Text>
      </Button>
      {expanded ? (
        <ChevronUp size={18} color={c.text3} />
      ) : (
        <ChevronDown size={18} color={c.text3} />
      )}
    </XStack>
  )
}

function McaRow({ data, ctx }: { data: McaRowData; ctx: McaRowContext }) {
  const c = useColors()
  const { mca, toolRows, testedAt } = data
  const expanded = ctx.expandedMcas.has(mca.mcaId)
  const nonRunnable = ctx.resolvabilityCache.get(mca.mcaId)?.runnable === false
  // Overlay any completed live result on top of the persisted/catalog rows (D-06), then recompute
  // BOTH the health aggregate and the overall status from the effective rows — so after a live
  // Retest the badge tracks the bar instead of showing the stale load-time `data.overall`.
  const effectiveRows = toolRows.map((tr) => ctx.liveResults.get(toolKey(mca.mcaId, tr.tool)) ?? tr)
  const health = computeHealth(effectiveRows)
  const overall = deriveOverall(effectiveRows)
  const testDisabled = nonRunnable || ctx.formOpen || ctx.runningMcas.has(mca.mcaId)

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius="$4"
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <McaRowBar
        mca={mca}
        overall={overall}
        expanded={expanded}
        testDisabled={testDisabled}
        health={health}
        onToggle={ctx.onToggle}
        onTest={ctx.onTest}
        t={ctx.t}
      />
      {/* Expanded body: read-only per-tool table (D-02) */}
      {expanded && (
        <McaToolTable
          mcaId={mca.mcaId}
          effectiveRows={effectiveRows}
          runningTools={ctx.runningTools}
          nonRunnable={nonRunnable}
          formOpen={ctx.formOpen}
          testedAt={testedAt}
          locale={ctx.locale}
          onRetestPress={ctx.onRetestPress}
          t={ctx.t}
        />
      )}
    </YStack>
  )
}

/** A collapsible content-category header (D-11) + its MCA rows. */
export function CategoryGroup({
  group,
  collapsed,
  onToggleCategory,
  ctx,
}: {
  group: { key: string; label: string; rows: McaRowData[] }
  collapsed: boolean
  onToggleCategory: (key: string) => void
  ctx: McaRowContext
}) {
  const c = useColors()
  return (
    <YStack gap="$2">
      <XStack
        alignItems="center"
        gap="$2"
        paddingVertical="$1"
        cursor="pointer"
        hoverStyle={{ opacity: 0.8 }}
        pressStyle={{ opacity: 0.6 }}
        onPress={() => onToggleCategory(group.key)}
      >
        {collapsed ? (
          <ChevronRight size={16} color={c.text3} />
        ) : (
          <ChevronDown size={16} color={c.text3} />
        )}
        <Text fontSize="$3" fontWeight="600" color="$color">
          {group.label}
        </Text>
        <Text fontSize="$2" color={c.text3}>
          ({group.rows.length})
        </Text>
      </XStack>
      {!collapsed &&
        group.rows.map((data) => <McaRow key={data.mca.mcaId} data={data} ctx={ctx} />)}
    </YStack>
  )
}
