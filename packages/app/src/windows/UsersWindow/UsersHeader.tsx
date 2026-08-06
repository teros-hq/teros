/**
 * UsersHeader — the admin Users panel header, in the Monitoring design family.
 *
 * Deliberately NOT `MonitoringHeader` (that one is coupled to the monitoring
 * suite's "Related views" chips + hub breadcrumb). This reuses the SAME tokens,
 * spacing and pill styling so it reads as part of the same family, but takes a
 * generic `crumbs` breadcrumb (list → detail drill-in) + an optional status pill
 * + a right/second-row `controls` slot (search box, actions…).
 */

import { ChevronLeft } from "@tamagui/lucide-icons"
import type { ReactNode } from "react"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../components/monitoring/colors"

export interface Crumb {
  label: string
  /** When set, the crumb is a pressable navigation target (e.g. back to the list). */
  onPress?: () => void
}

export function UsersHeader({
  crumbs,
  statusText,
  controls,
}: {
  crumbs: Crumb[]
  statusText?: string
  controls?: ReactNode
}) {
  return (
    <YStack
      gap={12}
      paddingVertical={16}
      paddingHorizontal={24}
      borderBottomWidth={1}
      borderBottomColor={tokens.border}
      // accent @ ~4% — matches MonitoringHeader, derived from the token (no hardcoded rgba).
      backgroundColor={`${tokens.accent}0A`}
    >
      <XStack ai="center" jc="space-between" gap={16}>
        <XStack ai="center" gap={8} minWidth={0} flex={1} flexWrap="wrap">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1
            const key = `${i}-${crumb.label}`
            return (
              <XStack key={key} ai="center" gap={8}>
                {i > 0 ? (
                  <Text fontSize={14} color={tokens.textMuted}>
                    /
                  </Text>
                ) : null}
                {isLast ? (
                  <Text
                    fontSize={20}
                    fontWeight="650"
                    color={tokens.text}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {crumb.label}
                  </Text>
                ) : crumb.onPress ? (
                  <XStack
                    ai="center"
                    gap={4}
                    cursor="pointer"
                    hoverStyle={{ opacity: 0.8 }}
                    onPress={crumb.onPress}
                    aria-label={`Back to ${crumb.label}`}
                    {...({ role: "button", tabIndex: 0 } as any)}
                  >
                    {i === 0 ? <ChevronLeft size={14} color={tokens.textTertiary} /> : null}
                    <Text fontSize={14} color={tokens.textTertiary}>
                      {crumb.label}
                    </Text>
                  </XStack>
                ) : (
                  <Text fontSize={14} color={tokens.textTertiary}>
                    {crumb.label}
                  </Text>
                )}
              </XStack>
            )
          })}
        </XStack>

        {statusText ? (
          <XStack
            ai="center"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={11}
            borderRadius={9999}
            borderWidth={1}
            borderColor={`${tokens.textTertiary}38`}
            backgroundColor={`${tokens.textTertiary}1A`}
          >
            <YStack
              width={7}
              height={7}
              borderRadius={9999}
              backgroundColor={tokens.textTertiary}
            />
            <Text fontSize={14} fontWeight="600" color={tokens.textTertiary} numberOfLines={1}>
              {statusText}
            </Text>
          </XStack>
        ) : null}
      </XStack>

      {controls ? (
        <XStack ai="center" gap={12} flexWrap="wrap">
          {controls}
        </XStack>
      ) : null}
    </YStack>
  )
}
