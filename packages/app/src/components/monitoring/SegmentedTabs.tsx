/**
 * SegmentedTabs — the in-window tab bar of the monitoring suite, drawn as the
 * OS prototype's `PTabs` (washed track, the active tab lifts to a card with the
 * accent glyph). Cross-window navigation lives in MonitoringHeader; this is for
 * switching sub-views WITHIN a window.
 *
 * Accessibility: `role="tablist"` / `role="tab"` + `aria-selected` / `aria-disabled`.
 */

import type { ComponentType } from "react"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds/Icon"
import { T } from "../ui/ds/Text"

export interface SegmentTab {
  key: string
  label: string
  /** Phosphor name (preferred) or a legacy icon component. */
  icon?: string | ComponentType<{ size?: number; color?: string }>
  /** Progressive disclosure: a tab with no data is shown dimmed and non-clickable. */
  disabled?: boolean
}

export function SegmentedTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: SegmentTab[]
  active: string
  onChange: (key: string) => void
}) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 4,
        padding: 4,
        borderRadius: 10,
        backgroundColor: c.wash,
        alignSelf: "flex-start",
        flexWrap: "wrap",
      }}
      {...({ role: "tablist" } as any)}
    >
      {tabs.map((t) => {
        const isActive = t.key === active
        const disabled = !!t.disabled
        const interactive = !disabled && !isActive
        const fg = isActive ? c.text : c.text2
        return (
          <Pressable
            key={t.key}
            onPress={interactive ? () => onChange(t.key) : undefined}
            disabled={!interactive}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive, disabled }}
            accessibilityLabel={t.label}
            {...({
              role: "tab",
              "aria-selected": isActive,
              "aria-disabled": disabled,
              "aria-label": t.label,
            } as any)}
            style={({ pressed }) => [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                height: 36,
                paddingHorizontal: 16,
                borderRadius: 10,
                backgroundColor: isActive ? c.bgStep : "transparent",
                opacity: disabled ? 0.4 : 1,
                transform: pressed && interactive ? [{ scale: 0.97 }] : undefined,
              },
              Platform.OS === "web"
                ? ({
                    cursor: interactive ? "pointer" : "default",
                    transition: "background 0.25s, box-shadow 0.25s",
                    boxShadow: isActive ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                    whiteSpace: "nowrap",
                  } as any)
                : null,
            ]}
          >
            {t.icon ? (
              typeof t.icon === "string" ? (
                <Ph name={t.icon} size={15} color={isActive ? c.accent : c.text2} />
              ) : (
                <t.icon size={14} color={isActive ? c.accent : c.text2} />
              )
            ) : null}
            <T step="sm" color={fg} numberOfLines={1}>
              {t.label}
            </T>
          </Pressable>
        )
      })}
    </View>
  )
}
