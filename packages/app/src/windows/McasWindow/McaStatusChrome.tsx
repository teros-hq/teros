/**
 * Static chrome for the MCA Health dashboard: the pinned summary cards (D-14) and the
 * availability-chip + search filter strip (D-08). Split out so the dashboard render stays under the
 * line/complexity limits (CLAUDE.md). Pure display — no run or fetch logic.
 */
import { EyeOff, Lock, Shield, Users } from "@tamagui/lucide-icons"
import type React from "react"
import { Input, Text, XStack, YStack } from "tamagui"
import { STATUS_COLORS, type AvailabilityFilters } from "./mcaHealth.utils"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"

type Translate = (key: string, opts?: Record<string, unknown>) => string

function SummaryCard({ value, label, color }: { value: number; label: string; color: string }) {
  const c = useColors()
  return (
    <YStack minWidth={80}>
      <Text fontSize="$6" fontWeight="700" color={color}>
        {value}
      </Text>
      <Text fontSize="$2" color={c.text2}>
        {label}
      </Text>
    </YStack>
  )
}

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
  const c = useColors()
  return (
    <XStack
      backgroundColor={c.bgInner}
      borderRadius="$4"
      padding="$4"
      gap="$4"
      borderWidth={1}
      borderColor={c.border}
      flexWrap="wrap"
    >
      <SummaryCard
        value={operational}
        label={t("mca.status.summary.operational")}
        color={STATUS_COLORS.operational}
      />
      <SummaryCard
        value={failed}
        label={t("mca.status.summary.failed")}
        color={STATUS_COLORS.failed}
      />
      <SummaryCard
        value={partial}
        label={t("mca.status.summary.partial")}
        color={STATUS_COLORS.partial}
      />
      <SummaryCard value={total} label={t("mca.status.summary.total")} color="$color" />
    </XStack>
  )
}

function Chip({
  active,
  label,
  icon,
  onToggle,
}: {
  active: boolean
  label: string
  icon: React.ReactNode
  onToggle: () => void
}) {
  const c = useColors()
  return (
    <XStack
      paddingHorizontal="$2.5"
      paddingVertical="$1.5"
      borderRadius="$3"
      borderWidth={1}
      alignItems="center"
      gap="$1.5"
      cursor="pointer"
      backgroundColor={active ? c.bgCardHover : c.bgInner}
      borderColor={c.borderStrong}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      pressStyle={{ opacity: 0.8 }}
      opacity={active ? 1 : 0.55}
      onPress={onToggle}
    >
      {icon}
      <Text fontSize="$2" color={c.text2}>
        {label}
      </Text>
    </XStack>
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
  const c = useColors()
  return (
    <XStack gap="$3" flexWrap="wrap" alignItems="center" justifyContent="space-between">
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Chip
          active={filters.showSystem}
          label={t("mca.status.filters.system")}
          icon={<Shield size={14} color={semanticColors.violet} />}
          onToggle={() => onToggle("showSystem")}
        />
        <Chip
          active={filters.showAdminOnly}
          label={t("mca.status.filters.adminOnly")}
          icon={<Users size={14} color={semanticColors.amber} />}
          onToggle={() => onToggle("showAdminOnly")}
        />
        <Chip
          active={filters.showUser}
          label={t("mca.status.filters.user")}
          icon={<Users size={14} color={semanticColors.green} />}
          onToggle={() => onToggle("showUser")}
        />
        <Chip
          active={filters.showHidden}
          label={t("mca.status.filters.hidden")}
          icon={<EyeOff size={14} color={c.text3} />}
          onToggle={() => onToggle("showHidden")}
        />
        <Chip
          active={filters.showDisabled}
          label={t("mca.status.filters.disabled")}
          icon={<Lock size={14} color={semanticColors.red} />}
          onToggle={() => onToggle("showDisabled")}
        />
      </XStack>
      <Input
        size="$3"
        minWidth={200}
        flexGrow={1}
        maxWidth={320}
        placeholder={t("mca.status.searchPlaceholder")}
        value={rawSearch}
        onChangeText={setRawSearch}
        backgroundColor={c.bgInner}
        borderColor={c.borderStrong}
      />
    </XStack>
  )
}
