import { useEffect, useRef, useState } from "react"
import { getDateLocale } from "../../../i18n"
import { Platform, Pressable, useWindowDimensions } from "react-native"
import { View, XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { ChipBtn, Ph, T } from "../../ui/ds"
import { TerosLoading } from "../../TerosLoading"
import { SelectableText } from "./shared"
import { QueuedIndicator, QueuedShimmer } from "../queuedDecorations"
import { formatDuration } from "./VoiceBubble"

/**
 * Audio message bubble - simple player for music, podcasts, etc.
 * No transcription, just playback controls with progress bar
 */
export function AudioBubble({
  url,
  duration,
  caption,
  mimeType,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
  onRetry,
}: {
  url: string
  duration?: number
  caption?: string
  mimeType?: string
  timestamp: Date
  isUser?: boolean
  showTimestamp?: boolean
  status?: "sending" | "sent" | "failed" | "queued"
  onRetry?: () => void
}) {
  const c = useColors()
  const { width: screenWidth } = useWindowDimensions()
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(duration || 0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // v1.3.4: same adaptive pattern as FileBubble/HtmlBubble v1.3.3 — narrow
  // screens fill the available width (symmetric margins); the 70%/400px cap
  // only applies on wide screens.
  const isNarrow = screenWidth < 640
  const maxWidth = isNarrow ? ("100%" as const) : Math.min(screenWidth * 0.7, 400)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
      }
      if (audioRef.current) {
        audioRef.current.pause()
      }
    }
  }, [])

  const togglePlayback = () => {
    if (Platform.OS === "web") {
      if (!audioRef.current) {
        audioRef.current = new Audio(url)
        audioRef.current.onloadedmetadata = () => {
          if (
            audioRef.current &&
            audioRef.current.duration &&
            isFinite(audioRef.current.duration)
          ) {
            setAudioDuration(audioRef.current.duration)
          }
        }
        audioRef.current.onended = () => {
          setIsPlaying(false)
          setCurrentTime(0)
          if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current)
          }
        }
      }

      if (isPlaying) {
        audioRef.current.pause()
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current)
        }
        setIsPlaying(false)
      } else {
        audioRef.current.play()
        setIsPlaying(true)
        progressIntervalRef.current = setInterval(() => {
          if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime)
          }
        }, 100)
      }
    }
    // TODO: Native audio playback with expo-audio
  }

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0
  const displayDuration = audioDuration || duration || 0

  const isQueued = status === "queued"

  return (
    <YStack
      maxWidth={maxWidth}
      width="100%"
      minWidth={0}
      gap="$2"
      alignSelf={isUser ? "flex-end" : "flex-start"}
      alignItems={isUser ? "flex-end" : "flex-start"}
    >
      <YStack
        width="100%"
        minWidth={0}
        alignSelf="stretch"
        padding={12}
        borderRadius={16}
        backgroundColor={c.bgStep}
        gap={8}
        overflow={isQueued ? "hidden" : undefined}
        position={isQueued ? "relative" : undefined}
        // @ts-ignore web-only lift
        style={Platform.OS === "web" ? { boxShadow: c.liftSm } : undefined}
      >
        {isQueued && <QueuedShimmer />}
        {/* Player controls */}
        <XStack alignItems="center" gap={12}>
          {/* Play/Pause Button */}
          <Pressable
            onPress={togglePlayback}
            accessibilityRole="button"
            style={{
              width: 40,
              height: 40,
              borderRadius: 100,
              backgroundColor: c.navActive,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ph name={isPlaying ? "stop" : "play"} size={16} weight="fill" color={c.accent} />
          </Pressable>

          {/* Progress bar and time */}
          <YStack flex={1} gap="$1">
            {/* Progress bar - clickable for seek */}
            <View
              height={12}
              paddingVertical={4}
              cursor="pointer"
              onPress={(e: any) => {
                if (Platform.OS === "web" && audioRef.current && audioDuration > 0) {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const clickX = e.clientX - rect.left
                  const percentage = clickX / rect.width
                  const newTime = percentage * audioDuration
                  audioRef.current.currentTime = newTime
                  setCurrentTime(newTime)
                }
              }}
            >
              <View height={4} backgroundColor={c.wash2} borderRadius={100} overflow="hidden">
                <View
                  height="100%"
                  width={`${progress * 100}%`}
                  backgroundColor={c.accent}
                  borderRadius={100}
                />
              </View>
            </View>

            {/* Time display */}
            <XStack justifyContent="space-between">
              <T step="codenote" tone="text3">
                {formatDuration(currentTime)}
              </T>
              <T step="codenote" tone="text3">
                {displayDuration > 0 ? formatDuration(displayDuration) : "--:--"}
              </T>
            </XStack>
          </YStack>
        </XStack>

        {/* Caption if present */}
        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {/* Status indicator for sending/failed */}
        {status && status !== "sent" && (
          <XStack alignItems="center" gap="$1">
            {status === "sending" && (
              <>
                <TerosLoading size={12} color={c.text3} />
                <T step="12" tone="text3">
                  Enviando...
                </T>
              </>
            )}
            {status === "failed" && (
              <XStack alignItems="center" gap={8}>
                <Ph name="warning-circle" size={12} color={c.tint.r.tx} />
                <T step="12" color={c.tint.r.tx}>
                  Error al enviar
                </T>
                {onRetry && (
                  <ChipBtn icon="arrow-clockwise" onPress={onRetry}>
                    Reintentar
                  </ChipBtn>
                )}
              </XStack>
            )}
          </XStack>
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
