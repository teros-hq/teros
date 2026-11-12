/**
 * Badge — the OS prototype's small status label (`.badge.sm`), local to the
 * MCA primitives: 10px sans on a status tint, radius 5 (or a pill), optional
 * glyph. Tones follow `useColors().tint`: success g · error r · warning a ·
 * info i · gray = neutral wash.
 */
import type React from "react"
import { XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

export type BadgeVariant = "success" | "error" | "info" | "warning" | "gray"

interface BadgeProps {
  text: string
  variant: BadgeVariant
  /** Glyph drawn before the text (already tinted by the caller — use `badgeColor`). */
  icon?: React.ReactNode
  /** Fully round ends. */
  pill?: boolean
  /** 9px uppercase tracked label (`.badge.cap`). */
  cap?: boolean
  testID?: string
}

const VARIANT_TO_TONE = {
  success: "g",
  error: "r",
  info: "i",
  warning: "a",
  gray: null,
} as const satisfies Record<BadgeVariant, "g" | "r" | "i" | "a" | null>

/** Foreground colour a `Badge` of this variant uses — for tinting an `icon`. */
export function useBadgeColor(variant: BadgeVariant): string {
  const c = useColors()
  const tone = VARIANT_TO_TONE[variant]
  return tone ? c.tint[tone].tx : c.text2
}

export function Badge({ text, variant, icon, pill, cap, testID }: BadgeProps) {
  const c = useColors()
  const tone = VARIANT_TO_TONE[variant]
  const bg = tone ? c.tint[tone].bg : c.wash
  const fg = tone ? c.tint[tone].tx : c.text2
  const fs = cap ? 9 : 10

  return (
    <XStack
      alignItems="center"
      gap={5}
      alignSelf="flex-start"
      flexShrink={0}
      paddingVertical={2}
      paddingHorizontal={7}
      borderRadius={pill ? 100 : 5}
      backgroundColor={bg}
      testID={testID}
    >
      {icon}
      <T
        step="sm"
        color={fg}
        numberOfLines={1}
        style={[
          { fontSize: fs, lineHeight: fs + 3 },
          cap ? { textTransform: "uppercase", letterSpacing: 1.3 } : null,
        ]}
      >
        {text}
      </T>
    </XStack>
  )
}
