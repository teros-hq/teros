import { useState } from "react"
import { getDateLocale } from "../../../i18n"
import { Image, Platform, useWindowDimensions } from "react-native"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { Ph, T } from "../../ui/ds"
import { QueuedIndicator, QueuedShimmer } from "../queuedDecorations"
import { SelectableText } from "./shared"

/**
 * Image message bubble
 */
export function ImageBubble({
  url,
  caption,
  width,
  height,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
}: {
  url: string
  caption?: string
  width?: number
  height?: number
  timestamp: Date
  isUser?: boolean
  showTimestamp?: boolean
  status?: "sending" | "sent" | "failed" | "queued"
}) {
  const c = useColors()
  const { width: screenWidth } = useWindowDimensions()
  const maxWidth = screenWidth * 0.7
  const [imageError, setImageError] = useState(false)

  // Calculate aspect ratio
  const aspectRatio = width && height ? width / height : 16 / 9
  const displayWidth = Math.min(maxWidth, width || maxWidth)
  const displayHeight = displayWidth / aspectRatio

  const [isModalOpen, setIsModalOpen] = useState(false)
  const openModal = () => setIsModalOpen(true)
  const closeModal = () => setIsModalOpen(false)

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
        {imageError ? (
          <XStack
            width={displayWidth}
            height={150}
            backgroundColor={c.nest}
            alignItems="center"
            justifyContent="center"
            gap={8}
          >
            <Ph name="image-broken" size={22} color={c.text3} />
            <T step="sm" tone="text3">
              Error loading image
            </T>
          </XStack>
        ) : Platform.OS === "web" ? (
          <img
            src={url}
            alt={caption || "Image"}
            style={{
              maxWidth: displayWidth,
              maxHeight: 400,
              borderRadius: 16,
              objectFit: "contain",
              cursor: "zoom-in",
              display: "block",
            }}
            onError={() => setImageError(true)}
            onClick={openModal}
          />
        ) : (
          <Image
            source={{ uri: url }}
            style={{
              width: displayWidth,
              height: Math.min(displayHeight, 400),
              borderRadius: 16,
            }}
            resizeMode="contain"
            onError={() => setImageError(true)}
          />
        )}

        {caption && (
          <YStack padding="$2" paddingTop="$1">
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

      {/* Fullscreen modal for web */}
      {Platform.OS === "web" && isModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(32,28,39,0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
          onClick={closeModal}
        >
          <div style={{ maxWidth: "95%", maxHeight: "95%" }} onClick={(e) => e.stopPropagation()}>
            <img
              src={url}
              alt={caption || "Image"}
              style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 8 }}
            />
          </div>
        </div>
      )}
    </YStack>
  )
}
