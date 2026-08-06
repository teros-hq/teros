import type React from "react"
import { Text, XStack } from "tamagui"

/** Small pill used for availability / overall-status labels across the health dashboard. */
export function Badge({
  children,
  color,
  icon,
}: {
  children: React.ReactNode
  color: string
  icon?: React.ReactNode
}) {
  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${color}30`}
      alignItems="center"
      gap="$1"
    >
      {icon}
      <Text fontSize="$1" color={color}>
        {children}
      </Text>
    </XStack>
  )
}
