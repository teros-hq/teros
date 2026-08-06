/**
 * FilterBar — the 5 filter dimensions of Agent Activity in the monitoring
 * suite's visual language. Provider chips are data-derived from the loaded
 * KPI buckets and carry the LOGICAL provider id (`teros`, `anthropic`, …) —
 * the exact key every backend query filters by (sessions.provider /
 * rollups groupKey.provider). They previously carried `actualProvider`
 * (fireworks/together), which zeroed the dashboard when selected (P4,
 * 2026-07-07 audit). User/agent/workspace come from the cascading directory;
 * trigger is a fixed backend enum. Plus a Clear button (only when a filter is
 * active) and an internal-IDs toggle.
 *
 * The dropdowns are native `<select>` (admin is web-only) — simpler than
 * Tamagui's declarative Select for 4 dropdowns, styled from the shared tokens.
 */

import React from "react"
import { providerColor, providerLabel } from "@teros/shared"
import { Text, XStack } from "tamagui"
import { tokens } from "../../../components/monitoring"
import type { FilterDirectory } from "../hooks/useDirectory"
import type { FilterKey, FilterState } from "../hooks/filtersHelpers"

/** Backend TriggerKind enum — stable server values (not user-facing ids). */
const TRIGGER_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "user_message", label: "User message" },
  { value: "delegation", label: "Delegation" },
  { value: "autorun", label: "Autorun" },
  { value: "scheduled", label: "Scheduled" },
  { value: "event_subscription", label: "Event subscription" },
]

const SELECT_STYLE: React.CSSProperties = {
  backgroundColor: tokens.bgInner,
  color: tokens.textSecondary,
  border: `1px solid ${tokens.borderHover}`,
  borderRadius: 8,
  padding: "6px 9px",
  fontSize: 13,
  minWidth: 132,
  maxWidth: 220,
  outline: "none",
  cursor: "pointer",
}

function FilterSelect(props: {
  value: string
  onValueChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
}) {
  return React.createElement("select", {
    value: props.value,
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => props.onValueChange(e.target.value),
    style: SELECT_STYLE,
    "aria-label": props.placeholder,
    children: [
      React.createElement("option", { key: "__all__", value: "" }, props.placeholder),
      ...props.options.map((o) =>
        React.createElement("option", { key: o.value, value: o.value }, o.label),
      ),
    ],
  } as any)
}

function Pill({
  label,
  count,
  active,
  color,
  onPress,
}: {
  label: string
  count?: number
  active: boolean
  color?: string
  onPress: () => void
}) {
  return (
    <XStack
      ai="center"
      gap={6}
      paddingVertical={5}
      paddingHorizontal={11}
      borderRadius={9999}
      borderWidth={1}
      borderColor={active ? tokens.borderHover : tokens.border}
      backgroundColor={active ? tokens.bgPress : tokens.bgInner}
      cursor="pointer"
      hoverStyle={active ? {} : { backgroundColor: tokens.bgHover }}
      onPress={onPress}
      aria-label={`Filter by ${label}`}
    >
      {color ? <XStack width={9} height={9} borderRadius={3} backgroundColor={color} /> : null}
      <Text fontSize={13} fontWeight="500" color={active ? tokens.text : tokens.textSecondary}>
        {label}
      </Text>
      {typeof count === "number" ? (
        <Text fontSize={12} fontFamily="$mono" color={tokens.textTertiary}>
          {count}
        </Text>
      ) : null}
    </XStack>
  )
}

export interface FilterBarProps {
  filters: FilterState
  setFilter: (key: FilterKey, value: string) => void
  clearAll: () => void
  hasAnyActive: boolean
  directory: FilterDirectory
  /** [logicalProviderId, sessionCount] derived from the loaded buckets — chips, not a stale enum. */
  providerCounts: [string, number][]
  /** Total sessions across all providers (the "All" chip count). */
  totalCount: number
  showInternalIds: boolean
  onToggleIds: () => void
}

export function FilterBar({
  filters,
  setFilter,
  clearAll,
  hasAnyActive,
  directory,
  providerCounts,
  totalCount,
  showInternalIds,
  onToggleIds,
}: FilterBarProps) {
  const toggleProvider = (id: string) => setFilter("provider", filters.provider === id ? "" : id)

  return (
    <XStack
      ai="center"
      flexWrap="wrap"
      gap={8}
      paddingHorizontal={24}
      paddingVertical={12}
      borderBottomWidth={1}
      borderBottomColor={tokens.border}
      backgroundColor={tokens.bgInner}
    >
      <FilterSelect
        value={filters.userId}
        onValueChange={(v) => setFilter("userId", v)}
        options={directory.userOptions}
        placeholder="All users"
      />
      <FilterSelect
        value={filters.agentId}
        onValueChange={(v) => setFilter("agentId", v)}
        options={directory.agentOptions}
        placeholder="All agents"
      />
      <FilterSelect
        value={filters.workspaceId}
        onValueChange={(v) => setFilter("workspaceId", v)}
        options={directory.workspaceOptions}
        placeholder="All workspaces"
      />
      <FilterSelect
        value={filters.triggerKind}
        onValueChange={(v) => setFilter("triggerKind", v)}
        options={TRIGGER_KIND_OPTIONS}
        placeholder="All triggers"
      />

      {/* provider chips (data-derived) */}
      {providerCounts.length > 0 ? (
        <XStack ai="center" gap={6} flexWrap="wrap">
          <Pill
            label="All"
            count={totalCount}
            active={filters.provider === ""}
            onPress={() => setFilter("provider", "")}
          />
          {providerCounts.map(([p, n]) => (
            <Pill
              key={p}
              label={providerLabel(p)}
              count={n}
              color={providerColor(p)}
              active={filters.provider === p}
              onPress={() => toggleProvider(p)}
            />
          ))}
        </XStack>
      ) : null}

      <XStack flex={1} minWidth={8} />

      {hasAnyActive ? (
        <XStack
          ai="center"
          paddingVertical={5}
          paddingHorizontal={11}
          borderRadius={8}
          borderWidth={1}
          borderColor={tokens.borderHover}
          cursor="pointer"
          hoverStyle={{ backgroundColor: tokens.bgHover }}
          onPress={clearAll}
          aria-label="Clear filters"
        >
          <Text fontSize={13} fontWeight="500" color={tokens.warning}>
            Clear
          </Text>
        </XStack>
      ) : null}

      <Pill label="IDs" active={showInternalIds} onPress={onToggleIds} />
    </XStack>
  )
}
