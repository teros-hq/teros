/**
 * InflightGauge — live count of LLM streams currently in flight per real
 * upstream (F1.3). A point-in-time reading of the backend's in-memory gauge
 * (NOT `status='running'`, which would leak crashed turns forever), so the
 * window polls it and shows how fresh the reading is. Pure presentation: the
 * polling lifecycle lives in `useInflightGauge`.
 *
 * No SVG — concurrency is a small integer; a big number + a proportional bar
 * per upstream reads instantly. Accessibility: numbers + text, not colour alone.
 */

import { Text, XStack, YStack } from "tamagui"
import { useColors } from "../../../components/mca/primitives/useColors"

export function InflightGauge({
  inflight,
  total,
  capturedAt,
  error,
}: {
  inflight: Record<string, number>
  total: number
  capturedAt: string | null
  error: string | null
}) {
  const c = useColors()
  const entries = Object.entries(inflight)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const maxN = Math.max(...entries.map(([, n]) => n), 1)

  return (
    <YStack gap={12}>
      <XStack ai="center" gap={20}>
        <YStack ai="center" minWidth={88}>
          <Text fontSize={42} fontWeight="800" color={total > 0 ? "$blue10" : "$gray9"} lineHeight={46}>
            {total}
          </Text>
          <Text fontSize={11} color="$gray10" textTransform="uppercase" letterSpacing={0.5}>
            in flight
          </Text>
        </YStack>

        <YStack flex={1} gap={8}>
          {entries.length === 0 ? (
            <Text fontSize={13} color="$gray10">
              Idle — no streams in flight right now.
            </Text>
          ) : (
            entries.map(([provider, n]) => (
              <XStack key={provider} ai="center" gap={10}>
                <Text fontSize={12} color="$gray11" minWidth={90}>
                  {provider}
                </Text>
                <YStack
                  flex={1}
                  height={8}
                  borderRadius={4}
                  backgroundColor={c.bgInner}
                  overflow="hidden"
                >
                  <YStack
                    height={8}
                    borderRadius={4}
                    backgroundColor="$blue10"
                    width={`${(n / maxN) * 100}%`}
                  />
                </YStack>
                <Text fontSize={12} fontWeight="600" color="$gray12" minWidth={28} textAlign="right">
                  {n}
                </Text>
              </XStack>
            ))
          )}
        </YStack>
      </XStack>

      <XStack ai="center" jc="space-between" gap={8} flexWrap="wrap">
        <Text fontSize={11} color="$gray9">
          {capturedAt
            ? `Updated ${new Date(capturedAt).toLocaleTimeString()} · this backend instance`
            : "Reading…"}
        </Text>
        {error ? (
          <Text fontSize={11} color="$orange10">
            ⚠ {error}
          </Text>
        ) : null}
      </XStack>
    </YStack>
  )
}
