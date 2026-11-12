import { Image, Linking, Platform, Pressable } from "react-native"
import { getDateLocale } from "../../../i18n"
import { Text, XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semanticColors } from "../../mca/primitives/colors"
import { Ph, T } from "../../ui/ds"
import { QueuedIndicator, QueuedShimmer } from "../queuedDecorations"
import { SelectableText } from "./shared"
import { formatDuration } from "./VoiceBubble"

/**
 * Video message bubble - inline player with native controls
 */
export function VideoBubble({
  url,
  caption,
  duration,
  thumbnailUrl,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
}: {
  url: string
  caption?: string
  duration?: number
  thumbnailUrl?: string
  timestamp: Date
  isUser?: boolean
  showTimestamp?: boolean
  status?: "sending" | "sent" | "failed" | "queued"
}) {
  const c = useColors()
  const handleOpenExternal = () => {
    if (Platform.OS === "web") {
      window.open(url, "_blank")
    } else {
      Linking.openURL(url)
    }
  }

  const isQueued = status === "queued"

  return (
    <YStack
      maxWidth="85%"
      gap="$2"
      alignSelf={isUser ? "flex-end" : "flex-start"}
      alignItems={isUser ? "flex-end" : "flex-start"}
    >
      <YStack
        borderRadius={16}
        overflow="hidden"
        backgroundColor={c.bgStep}
        position={isQueued ? "relative" : undefined}
        // @ts-ignore web-only lift
        style={Platform.OS === "web" ? { boxShadow: c.liftSm } : undefined}
      >
        {isQueued && <QueuedShimmer />}
        {/* Inline video player */}
        {Platform.OS === "web" ? (
          <video
            src={url}
            controls
            poster={thumbnailUrl}
            style={{
              width: "100%",
              maxWidth: 400,
              borderRadius: 16,
              display: "block",
              backgroundColor: c.nest,
            }}
          />
        ) : (
          // Fallback for native - show thumbnail with play button
          <XStack
            height={200}
            backgroundColor={c.nest}
            alignItems="center"
            justifyContent="center"
            position="relative"
          >
            {thumbnailUrl ? (
              <Image
                source={{ uri: thumbnailUrl }}
                style={{
                  width: "100%",
                  height: "100%",
                  position: "absolute",
                }}
                resizeMode="cover"
              />
            ) : (
              <Ph name="video" size={44} color={c.text3} />
            )}

            <Pressable
              onPress={handleOpenExternal}
              style={{
                width: 56,
                height: 56,
                borderRadius: 100,
                backgroundColor: semanticColors.purple300,
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1,
              }}
            >
              <Ph name="play" size={22} weight="fill" color="#FFFFFF" />
            </Pressable>

            {duration && (
              <Text
                position="absolute"
                bottom={8}
                right={8}
                backgroundColor={c.inkPill}
                paddingHorizontal="$2"
                paddingVertical="$1"
                borderRadius={100}
                color={c.inkPillText}
                fontSize={11}
              >
                {formatDuration(duration)}
              </Text>
            )}
          </XStack>
        )}

        {caption && (
          <YStack padding="$2">
            <SelectableText color={c.text} fontSize="$3" selectable>
              {caption}
            </SelectableText>
          </YStack>
        )}
      </YStack>

      {(showTimestamp || isQueued) && (
        <XStack alignItems="center" gap="$2">
          {isQueued && <QueuedIndicator />}
          {showTimestamp && (
            <T step="codenote" tone="text3" selectable>
              {timestamp.toLocaleTimeString(getDateLocale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </T>
          )}
        </XStack>
      )}
    </YStack>
  )
}
