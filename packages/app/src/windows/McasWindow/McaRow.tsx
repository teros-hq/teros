/**
 * A single MCA's collapsed health bar + its expanded read-only per-tool table (HEALTH-04 / D-01..07).
 * Split out of the dashboard so the row render stays under the cognitive-complexity limit
 * (CLAUDE.md): the availability chip, the segmented health bar, and each tool row are their own
 * small components. Display + per-row controls only — all run logic lives in useMcaHealthRunner.
 */
import { Platform, Pressable, View } from "react-native"
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
import { Btn, LGroup, LRow, Ph, T, Tile } from "../../components/ui/ds"

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
    <View style={{ flex: 1, minWidth: 60, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          flex: 1,
          height: 6,
          borderRadius: 100,
          overflow: "hidden",
          flexDirection: "row",
          backgroundColor: c.wash2,
        }}
      >
        {counted === 0 ? (
          // Never tested — single neutral grey segment (D-05).
          <View style={{ flex: 1, backgroundColor: STATUS_COLORS.pending, opacity: 0.35 }} />
        ) : (
          <>
            {passing > 0 && <View style={{ flex: passing, backgroundColor: STATUS_COLORS.ok }} />}
            {confirm > 0 && (
              <View style={{ flex: confirm, backgroundColor: STATUS_COLORS.confirm }} />
            )}
            {fail > 0 && <View style={{ flex: fail, backgroundColor: STATUS_COLORS.fail }} />}
          </>
        )}
      </View>
      <T
        step="codenote"
        tone="text3"
        style={{ minWidth: 48, textAlign: "right", textTransform: "none" }}
      >
        {counted === 0 ? t("mca.status.healthBar.notTested") : `${passing}/${counted}`}
      </T>
    </View>
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
  // Flat row: name · tested-at · status · notes · retest — all direct children so the
  // name's parent is the row (the per-tool status lives next to it).
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: c.border,
      }}
    >
      <T step="code" style={{ flex: 2, minWidth: 0 }} numberOfLines={1}>
        {tr.tool}
      </T>
      {toolTestedAt ? (
        <T step="12" tone="text3" numberOfLines={1} style={{ flexShrink: 1 }}>
          {t("mca.status.toolTestedAt", { date: toolTestedAt })}
        </T>
      ) : null}
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
        {running ? (
          <AppSpinner size="sm" />
        ) : (
          <Badge color={STATUS_COLORS[tr.status]}>{t(`mca.status.toolStatus.${tr.status}`)}</Badge>
        )}
      </View>
      <T step="12" tone="text3" style={{ flex: 3 }} numberOfLines={2}>
        {running ? t("mca.status.run.inFlight") : (tr.notes ?? "")}
      </T>
      <Btn
        variant="sec"
        size="sm"
        icon="arrows-clockwise"
        disabled={retestDisabled}
        onPress={() => onRetestPress(mcaId, tr.tool)}
      >
        {t("mca.status.retestTool")}
      </Btn>
    </View>
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
    <View style={{ backgroundColor: c.wash, borderTopWidth: 1, borderTopColor: c.border }}>
      {testedAtLabel || nonRunnable ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 8 }}>
          {testedAtLabel ? (
            <T step="12" tone="text3">
              {t("mca.status.testedAt", { date: testedAtLabel })}
            </T>
          ) : null}
          {/* Non-runnable reason (SC5) — MCA can't be tested (D-13/D-14). `reason` is a typed wire
              code, never display text, so always render the localized copy (REQ-16/AC-14). */}
          {nonRunnable ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge color={STATUS_COLORS.pending}>
                {t("mca.status.nonRunnable.installToTest")}
              </Badge>
              <T step="12" tone="text3" style={{ flex: 1 }}>
                {t("mca.status.nonRunnable.reason")}
              </T>
            </View>
          ) : null}
        </View>
      ) : null}
      {/* Table header (Tool / Status / Notes) */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 6,
        }}
      >
        <T step="xs" tone="text3" style={{ flex: 2 }}>
          {t("mca.status.columns.tool")}
        </T>
        <T step="xs" tone="text3" style={{ flex: 1 }}>
          {t("mca.status.columns.status")}
        </T>
        <T step="xs" tone="text3" style={{ flex: 3 }}>
          {t("mca.status.columns.notes")}
        </T>
        <View style={{ width: 90 }} />
      </View>
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
    </View>
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
    <LRow hov gap={12} onPress={() => onToggle(mca.mcaId)}>
      <Tile xs icon="package" tone="muted" />
      <T step="sm" numberOfLines={1} style={{ flexShrink: 1, minWidth: 80 }}>
        {mca.name}
      </T>
      <Badge color={STATUS_COLORS[mca.availability.system ? "pending" : overall]}>
        {availabilityLabel(mca, t)}
      </Badge>
      <Badge color={STATUS_COLORS[overall]}>{overallLabel(overall, t)}</Badge>
      <McaHealthBar {...health} t={t} />
      <Btn
        variant="primary"
        size="sm"
        icon="play"
        disabled={testDisabled}
        onPress={(e: any) => {
          e?.stopPropagation?.()
          onTest(mca.mcaId)
        }}
      >
        {t("mca.status.test")}
      </Btn>
      <Ph name={expanded ? "caret-up" : "caret-down"} size={14} color={c.text3} />
    </LRow>
  )
}

function McaRow({ data, ctx }: { data: McaRowData; ctx: McaRowContext }) {
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
    <View>
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
    </View>
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
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => onToggleCategory(group.key)}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <Ph name={collapsed ? "caret-right" : "caret-down"} size={12} color={c.text3} />
        <T step="xs" tone="text2">
          {group.label}
        </T>
        <View style={{ flex: 1, height: 1, backgroundColor: c.border, opacity: 0.7 }} />
        <T step="codenote" tone="text3">
          {String(group.rows.length)}
        </T>
      </Pressable>
      {!collapsed && (
        <LGroup>
          {group.rows.map((data) => (
            <McaRow key={data.mca.mcaId} data={data} ctx={ctx} />
          ))}
        </LGroup>
      )}
    </View>
  )
}
