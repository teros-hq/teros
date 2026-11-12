/**
 * Static chrome for the MCA Health dashboard: the pinned summary stats (D-14) and the
 * availability-chip + search filter strip (D-08). Split out so the dashboard render stays under the
 * line/complexity limits (CLAUDE.md). Pure display — no run or fetch logic.
 */
import { View } from "react-native"
import { ChipBtn, Field, Stat, Stats } from "../../components/ui/ds"
import type { AvailabilityFilters } from "./mcaHealth.utils"

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** Pinned summary counts from the full catalog — not affected by filters/search (D-14). */
export function SummaryCards({
  operational,
  failed,
  partial,
  total,
  t,
}: {
  operational: number
  failed: number
  partial: number
  total: number
  t: Translate
}) {
  return (
    <Stats cols={4}>
      <Stat v={operational} label={t("mca.status.summary.operational")} accent />
      <Stat v={failed} label={t("mca.status.summary.failed")} />
      <Stat v={partial} label={t("mca.status.summary.partial")} />
      <Stat v={total} label={t("mca.status.summary.total")} />
    </Stats>
  )
}

/** Availability chips (left) + debounced search box (right) (D-08). */
export function FilterStrip({
  filters,
  onToggle,
  rawSearch,
  setRawSearch,
  t,
}: {
  filters: AvailabilityFilters
  onToggle: (key: keyof AvailabilityFilters) => void
  rawSearch: string
  setRawSearch: (v: string) => void
  t: Translate
}) {
  const chips: Array<{ key: keyof AvailabilityFilters; label: string; icon: string }> = [
    { key: "showSystem", label: t("mca.status.filters.system"), icon: "shield-check" },
    { key: "showAdminOnly", label: t("mca.status.filters.adminOnly"), icon: "users-three" },
    { key: "showUser", label: t("mca.status.filters.user"), icon: "user" },
    { key: "showHidden", label: t("mca.status.filters.hidden"), icon: "eye-slash" },
    { key: "showDisabled", label: t("mca.status.filters.disabled"), icon: "lock" },
  ]
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {chips.map((chip) => (
          <ChipBtn
            key={chip.key}
            icon={chip.icon}
            on={filters[chip.key]}
            onPress={() => onToggle(chip.key)}
          >
            {chip.label}
          </ChipBtn>
        ))}
      </View>
      <Field
        icon="magnifying-glass"
        placeholder={t("mca.status.searchPlaceholder")}
        value={rawSearch}
        onChangeText={setRawSearch}
        containerStyle={{ minWidth: 200, flexGrow: 1, maxWidth: 320 }}
      />
    </View>
  )
}
