/**
 * BrowserbaseLiveViewBubble
 *
 * Chat bubble rendered when the agent calls session-create on Browserbase.
 * Shows a compact card with session info and a button to open the Live View window.
 */

import React from "react"
import { Platform } from "react-native"
import { getDateLocale } from "../../../i18n"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semanticColors } from "../../mca/primitives/colors"
import { Btn, Dot, Ph, T } from "../../ui/ds"
import { useTilingStore } from "../../../store/tilingStore"
import { SelectableText } from "./shared"

interface Props {
  sessionId: string
  url: string
  caption?: string
  timestamp: Date
  showTimestamp?: boolean
}

export function BrowserbaseLiveViewBubble({
  sessionId,
  url,
  caption,
  timestamp,
  showTimestamp = true,
}: Props) {
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  const shortId = sessionId.slice(0, 8)

  const handleOpen = () => {
    openWindow("browserbase-live-view", { sessionId, liveViewUrl: url, caption }, true)
  }

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf="flex-start">
      {/* Card */}
      <YStack
        backgroundColor={c.bgStep}
        borderRadius={16}
        overflow="hidden"
        width={320}
        padding={12}
        gap={10}
        // @ts-ignore web-only lift
        style={Platform.OS === "web" ? { boxShadow: c.liftSm } : undefined}
      >
        {/* Header */}
        <XStack alignItems="center" gap={10}>
          <YStack
            width={32}
            height={32}
            borderRadius={9}
            backgroundColor={c.tile}
            alignItems="center"
            justifyContent="center"
          >
            <Ph name="monitor-play" size={16} color={c.accent} />
          </YStack>
          <YStack flex={1} minWidth={0} gap={1}>
            <T step="sm">Browserbase Session</T>
            <T step="codenote" tone="text3">
              session {shortId}…
            </T>
          </YStack>
          {/* Live dot */}
          <XStack alignItems="center" gap={5}>
            <Dot color={semanticColors.green} size={6} />
            <T step="codenote" color={c.tint.g.tx}>
              live
            </T>
          </XStack>
        </XStack>

        {/* Open Live View button */}
        <Btn variant="sec" size="sm" icon="arrow-square-out" full onPress={handleOpen}>
          Open Live View
        </Btn>
      </YStack>

      {caption && (
        <SelectableText color={c.text2} fontSize="$3" selectable>
          {caption}
        </SelectableText>
      )}

      {showTimestamp && (
        <T step="codenote" tone="text3" selectable>
          {timestamp.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })}
        </T>
      )}
    </YStack>
  )
}
