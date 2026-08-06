/**
 * Small shared bits for the Agent Activity detail panels — a proportion bar and
 * the honest-degradation note. Kept together so every panel communicates a gap
 * the SAME way ("not measured for this provider", never a fake 0).
 */

import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring"

/** Horizontal proportion bar (0..1), tokenized, no SVG (jsdom-safe). */
export function HBar({
  value,
  color = tokens.accent,
  height = 8,
  track = tokens.bgPress,
}: {
  value: number
  color?: string
  height?: number
  track?: string
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100
  return (
    <YStack flex={1} height={height} borderRadius={height / 2} backgroundColor={track} overflow="hidden">
      <YStack width={`${pct}%`} height={height} borderRadius={height / 2} backgroundColor={color} />
    </YStack>
  )
}

/**
 * Honest empty / degradation note. `tone="muted"` for "no data in range",
 * `tone="warn"` for "not measured here" (a real gap the panel must not fake).
 */
export function PanelNote({ children, tone = "muted" }: { children: string; tone?: "muted" | "warn" }) {
  return (
    <Text fontSize={13} color={tone === "warn" ? tokens.warning : tokens.textTertiary} paddingVertical={8}>
      {children}
    </Text>
  )
}

/** A compact stat cell for a row of panel headline numbers. */
export function Stat({
  label,
  value,
  sub,
  color = tokens.text,
}: {
  label: string
  value: string
  sub?: string
  color?: string
}) {
  return (
    <YStack gap={3} minWidth={110}>
      <Text fontSize={11} fontWeight="600" letterSpacing={0.5} textTransform="uppercase" color={tokens.textTertiary}>
        {label}
      </Text>
      <Text fontSize={22} fontWeight="700" color={color} fontFamily="$mono">
        {value}
      </Text>
      {sub ? (
        <Text fontSize={11} color={tokens.textTertiary}>
          {sub}
        </Text>
      ) : null}
    </YStack>
  )
}
