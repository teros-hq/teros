/**
 * FilterBar — the 5 filter dimensions of Agent Activity in the OS prototype's
 * vocabulary: a `Card pad` holding a row of select fields + provider chips +
 * the Clear / IDs controls. Provider chips are data-derived from the loaded
 * KPI buckets and carry the LOGICAL provider id (`teros`, `anthropic`, …) —
 * the exact key every backend query filters by (sessions.provider /
 * rollups groupKey.provider). They previously carried `actualProvider`
 * (fireworks/together), which zeroed the dashboard when selected (P4,
 * 2026-07-07 audit). User/agent/workspace come from the cascading directory;
 * trigger is a fixed backend enum. Plus a Clear button (only when a filter is
 * active) and an internal-IDs toggle.
 *
 * The dropdowns stay native `<select>` (admin is web-only) for the real picker
 * behaviour; a transparent select sits over a `SelectField` so the trigger
 * draws like the design system's 36px field.
 */

import React from "react"
import { providerColor, providerLabel } from "@teros/shared"
import { Platform, View } from "react-native"
import { Dot } from "../../../components/ui/ds/Badge"
import { Btn, ChipBtn } from "../../../components/ui/ds/Buttons"
import { Card } from "../../../components/ui/ds/Card"
import { SelectField } from "../../../components/ui/ds/Field"
import { T } from "../../../components/ui/ds/Text"
import { useColors } from "../../../components/mca/primitives/useColors"
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

/** Invisible native select stretched over the styled trigger (web only). */
const NATIVE_SELECT_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  opacity: 0,
  cursor: "pointer",
  margin: 0,
  padding: 0,
  border: 0,
  fontSize: 13,
}

function FilterSelect(props: {
  value: string
  onValueChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  icon: string
}) {
  const c = useColors()
  const active = props.value !== ""
  const current = props.options.find((o) => o.value === props.value)?.label ?? props.placeholder
  return (
    <View style={{ position: "relative", minWidth: 150, maxWidth: 240 }}>
      <SelectField
        icon={props.icon}
        label={current}
        style={active ? { borderColor: c.borderAccentStrong } : undefined}
      />
      {Platform.OS === "web"
        ? React.createElement("select", {
            value: props.value,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
              props.onValueChange(e.target.value),
            style: NATIVE_SELECT_STYLE,
            "aria-label": props.placeholder,
            children: [
              React.createElement("option", { key: "__all__", value: "" }, props.placeholder),
              ...props.options.map((o) =>
                React.createElement("option", { key: o.value, value: o.value }, o.label),
              ),
            ],
          } as any)
        : null}
    </View>
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
  const c = useColors()
  const toggleProvider = (id: string) => setFilter("provider", filters.provider === id ? "" : id)

  return (
    <Card pad>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <FilterSelect
          icon="user"
          value={filters.userId}
          onValueChange={(v) => setFilter("userId", v)}
          options={directory.userOptions}
          placeholder="All users"
        />
        <FilterSelect
          icon="robot"
          value={filters.agentId}
          onValueChange={(v) => setFilter("agentId", v)}
          options={directory.agentOptions}
          placeholder="All agents"
        />
        <FilterSelect
          icon="buildings"
          value={filters.workspaceId}
          onValueChange={(v) => setFilter("workspaceId", v)}
          options={directory.workspaceOptions}
          placeholder="All workspaces"
        />
        <FilterSelect
          icon="lightning"
          value={filters.triggerKind}
          onValueChange={(v) => setFilter("triggerKind", v)}
          options={TRIGGER_KIND_OPTIONS}
          placeholder="All triggers"
        />

        {/* provider chips (data-derived) */}
        {providerCounts.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <ChipBtn
              on={filters.provider === ""}
              count={totalCount}
              onPress={() => setFilter("provider", "")}
              {...({ "aria-label": "Filter by All" } as any)}
            >
              All
            </ChipBtn>
            {providerCounts.map(([p, n]) => {
              const on = filters.provider === p
              return (
                <ChipBtn
                  key={p}
                  on={on}
                  count={n}
                  onPress={() => toggleProvider(p)}
                  {...({ "aria-label": `Filter by ${providerLabel(p)}` } as any)}
                >
                  <Dot color={providerColor(p)} size={7} />
                  <T step="12" color={on ? c.accent : c.text2} numberOfLines={1}>
                    {providerLabel(p)}
                  </T>
                </ChipBtn>
              )
            })}
          </View>
        ) : null}

        <View style={{ flex: 1, minWidth: 8 }} />

        {hasAnyActive ? (
          <Btn
            variant="ghost"
            size="sm"
            icon="x"
            onPress={clearAll}
            {...({ "aria-label": "Clear filters" } as any)}
          >
            Clear
          </Btn>
        ) : null}

        <ChipBtn
          mono
          on={showInternalIds}
          icon="identification-badge"
          onPress={onToggleIds}
          {...({ "aria-label": "Filter by IDs" } as any)}
        >
          IDs
        </ChipBtn>
      </View>
    </Card>
  )
}
