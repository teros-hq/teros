/**
 * SegmentedTabs — an in-window tab bar for the monitoring suite (the design has
 * no tabs primitive; cross-window navigation lives in MonitoringHeader, this is
 * for switching sub-views WITHIN a window). Styled with the same tokens as the
 * MonitoringHeader chips / ProviderChip (active = bgPress + borderHover; inactive
 * = transparent over the strip's bgInner; disabled = dimmed, non-interactive).
 *
 * Accessibility: `role="tablist"` / `role="tab"` + `aria-selected` / `aria-disabled`.
 */

import type { Activity } from "@tamagui/lucide-icons"
import { Text, XStack } from "tamagui"
import { tokens } from "./colors"

export interface SegmentTab {
  key: string
  label: string
  icon?: typeof Activity
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
  return (
    <XStack
      ai="center"
      gap={2}
      padding={3}
      borderRadius={10}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgInner}
      flexWrap="wrap"
      role="tablist"
    >
      {tabs.map((t) => {
        const isActive = t.key === active
        const disabled = !!t.disabled
        const interactive = !disabled && !isActive
        return (
          <XStack
            key={t.key}
            ai="center"
            gap={7}
            paddingVertical={7}
            paddingHorizontal={13}
            borderRadius={8}
            backgroundColor={isActive ? tokens.bgPress : "transparent"}
            borderWidth={1}
            borderColor={isActive ? tokens.borderHover : "transparent"}
            opacity={disabled ? 0.4 : 1}
            cursor={interactive ? "pointer" : "default"}
            hoverStyle={interactive ? { backgroundColor: tokens.bgHover } : {}}
            onPress={interactive ? () => onChange(t.key) : undefined}
            role="tab"
            aria-selected={isActive}
            aria-disabled={disabled}
            aria-label={t.label}
          >
            {t.icon ? <t.icon size={14} color={isActive ? tokens.text : tokens.textSecondary} /> : null}
            <Text fontSize={13} fontWeight={isActive ? "600" : "500"} color={isActive ? tokens.text : tokens.textSecondary}>
              {t.label}
            </Text>
          </XStack>
        )
      })}
    </XStack>
  )
}
