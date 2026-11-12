import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getDateLocale } from "../../../i18n"
import { Platform, Pressable, useWindowDimensions } from "react-native"
import { Popover, View, XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semanticColors, surface } from "../../mca/primitives/colors"
import { IconBtn, Ph, T } from "../../ui/ds"
import { TerosLoading } from "../../TerosLoading"
import { QueuedIndicator, QueuedShimmer } from "../queuedDecorations"
import { SelectableText } from "./shared"
import { backendUrl } from "../../../config/runtime"

// Format duration as m:ss
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/**
 * Voice message bubble with playback controls and transcription
 * Used for voice notes from users or TTS from agents
 */
export function VoiceBubble({
  url,
  data,
  duration,
  transcription,
  transcriptionError,
  timestamp,
  isUser = false,
  showTimestamp = true,
  onRetry,
  onDownload,
  status,
}: {
  url: string
  data?: string
  duration?: number
  transcription?: string
  transcriptionError?: string
  timestamp: Date
  isUser?: boolean
  showTimestamp?: boolean
  onRetry?: () => void
  onDownload?: () => void
  status?: "sending" | "sent" | "failed" | "queued"
}) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const { width: screenWidth } = useWindowDimensions()
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(duration || 0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // For iOS: calculate max text width based on screen (85% max - padding - button - gap)
  const maxTextWidth = Platform.OS !== "web" ? screenWidth * 0.85 - 32 - 36 - 16 : undefined

  // Convert relative URLs to absolute URLs using backend base from env
  const audioUrl = useMemo(() => {
    if (!url) return ""
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:")) {
      return url
    }
    return `${backendUrl()}${url}`
  }, [url])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  // Reset audio when URL changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setIsPlaying(false)
      setCurrentTime(0)
    }
  }, [audioUrl])

  const togglePlayback = async () => {
    if (Platform.OS === "web") {
      try {
        if (!audioRef.current || audioRef.current.src !== audioUrl) {
          // Clean up old audio if exists
          if (audioRef.current) {
            audioRef.current.pause()
          }
          audioRef.current = new Audio(audioUrl)
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
          audioRef.current.onerror = (e) => {
            console.error("[VoiceBubble] Audio error:", e)
            setIsPlaying(false)
          }
        }

        if (isPlaying) {
          audioRef.current.pause()
          if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current)
          }
          setIsPlaying(false)
        } else {
          await audioRef.current.play()
          setIsPlaying(true)
          // Update progress every 100ms
          progressIntervalRef.current = setInterval(() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime)
            }
          }, 100)
        }
      } catch (error) {
        console.error("[VoiceBubble] Playback error:", error)
        setIsPlaying(false)
      }
    }
    // TODO: Native audio playback with expo-audio
  }

  // Download audio file
  const handleDownload = () => {
    if (onDownload) {
      onDownload()
      setMenuOpen(false)
      return
    }

    if (Platform.OS === "web") {
      const link = document.createElement("a")
      link.href = audioUrl || (data ? `data:audio/webm;base64,${data}` : "")
      link.download = `voice-${timestamp.getTime()}.webm`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
    setMenuOpen(false)
  }

  // Retry sending failed message
  const handleRetry = () => {
    if (onRetry) {
      onRetry()
    }
    setMenuOpen(false)
  }

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0
  const displayDuration = audioDuration || duration || 0

  // Own voice bubbles ride the same mint glow as the own text bubble
  // (`.bubble`): Mint/100 in light, the mint tint in dark. Agent voice is a
  // card one step off the sheet.
  const mintFill = isDark ? c.tint.m.bg : semanticColors.mint100
  const bgColor = isUser ? mintFill : c.bgStep
  const borderRadius = 22
  const cornerRadius = 4
  const fg = c.text
  const fg3 = c.text3

  const isQueued = status === "queued"

  return (
    <YStack
      maxWidth="85%"
      {...(Platform.OS !== "web" ? { width: "85%" } : {})}
      gap="$2"
      alignSelf={isUser ? "flex-end" : "flex-start"}
      alignItems={isUser ? "flex-end" : "flex-start"}
      // @ts-ignore - userSelect is valid for web
      userSelect={Platform.OS === "web" ? "text" : undefined}
    >
      <YStack
        paddingVertical={10}
        paddingHorizontal={isUser ? 18 : 14}
        borderRadius={borderRadius}
        gap={8}
        backgroundColor={bgColor}
        borderTopRightRadius={isUser ? cornerRadius : borderRadius}
        borderTopLeftRadius={isUser ? borderRadius : cornerRadius}
        overflow={isQueued ? "hidden" : undefined}
        position="relative"
        // @ts-ignore web-only glow / lift
        style={
          Platform.OS === "web"
            ? { boxShadow: isUser ? `0 0 14px 8px ${mintFill}` : c.liftSm }
            : undefined
        }
      >
        {isQueued && <QueuedShimmer tone={isUser ? "mint" : "neutral"} />}
        {/* Transcription with play button */}
        <XStack alignItems="flex-start" gap="$2" flexWrap="nowrap">
          <View
            style={Platform.OS === "web" ? { flex: 1 } : { flexShrink: 1, maxWidth: maxTextWidth }}
          >
            {transcription ? (
              <XStack alignItems="flex-start" gap={6}>
                <View style={{ paddingTop: 5 }}>
                  <Ph name="microphone" size={13} color={c.accent} />
                </View>
                <SelectableText
                  color={isUser ? fg : c.text}
                  fontSize={isUser ? 16 : 17}
                  lineHeight={isUser ? 23 : 25}
                  fontFamily={isUser ? ("Saans" as any) : ("Prody" as any)}
                  selectable
                  flex={1}
                >
                  "{transcription}"
                </SelectableText>
              </XStack>
            ) : transcriptionError ? (
              <XStack alignItems="center" gap={6}>
                <Ph name="warning-circle" size={14} color={c.tint.a.tx} />
                <T step="sm" color={c.tint.a.tx}>
                  {t("voice.transcriptionFailed")}
                </T>
              </XStack>
            ) : status === "failed" ? (
              <XStack alignItems="center" gap={6}>
                <Ph name="warning-circle" size={14} color={c.tint.r.tx} />
                <T step="sm" color={c.tint.r.tx}>
                  {t("voice.sendFailed")}
                </T>
              </XStack>
            ) : status === "sending" ? (
              <T step="sm" color={fg3}>
                {t("voice.sending")}
              </T>
            ) : (
              <XStack alignItems="center" gap="$2">
                <TerosLoading size={20} color={c.accent} />
                <T step="sm" color={fg3}>
                  {t("voice.generatingTranscription")}
                </T>
              </XStack>
            )}
          </View>

          {/* Play/Stop Button — hidden when no audio URL (e.g. G2 glasses messages). */}
          {audioUrl && (
            <View style={{ flexShrink: 0 }}>
              <Pressable
                onPress={togglePlayback}
                accessibilityRole="button"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 100,
                  backgroundColor: c.navActive,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ph name={isPlaying ? "stop" : "play"} size={14} weight="fill" color={c.accent} />
              </Pressable>
            </View>
          )}

          {/* Options Menu (three dots) — hidden when no audio URL */}
          {audioUrl && (
            <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
              <Popover.Trigger asChild>
                <View style={{ flexShrink: 0 }}>
                  <IconBtn
                    icon="dots-three-vertical"
                    plain
                    sm
                    weight="bold"
                    onPress={() => setMenuOpen(true)}
                  />
                </View>
              </Popover.Trigger>

              <Popover.Content
                backgroundColor={c.bgStep}
                borderWidth={0}
                borderRadius={12}
                padding={4}
                elevate
                animation="quick"
                enterStyle={{ opacity: 0, y: -4 }}
                exitStyle={{ opacity: 0, y: -4 }}
              >
                {/* Download option */}
                <XStack
                  paddingHorizontal={12}
                  paddingVertical={8}
                  gap={8}
                  alignItems="center"
                  borderRadius={8}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: c.nest }}
                  onPress={handleDownload}
                >
                  <Ph name="download-simple" size={14} color={c.accent} />
                  <T step="sm" tone="text2">
                    {t("voice.download")}
                  </T>
                </XStack>

                {/* Retry option - show for send failure or transcription failure */}
                {(status === "failed" || transcriptionError || onRetry) && (
                  <XStack
                    paddingHorizontal={12}
                    paddingVertical={8}
                    gap={8}
                    alignItems="center"
                    borderRadius={8}
                    cursor="pointer"
                    hoverStyle={{ backgroundColor: c.nest }}
                    onPress={handleRetry}
                  >
                    <Ph name="arrow-clockwise" size={14} color={c.tint.a.tx} />
                    <T step="sm" tone="text2">
                      {transcriptionError ? t("voice.retryTranscription") : t("voice.retrySending")}
                    </T>
                  </XStack>
                )}
              </Popover.Content>
            </Popover>
          )}
        </XStack>

        {/* Timestamp + queued indicator (alineados al mismo nivel).
            v2 (§2.10, UX §8.2): the meta reads "13:26 · Voz" — same size,
            same legibility as the text: spoken words are first-class
            content. */}
        {(showTimestamp || isQueued) && (
          <XStack alignItems="center" gap="$2">
            {isQueued && <QueuedIndicator />}
            {showTimestamp && (
              <T step="codenote" color={fg3} selectable>
                {timestamp.toLocaleTimeString(getDateLocale(), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {` · ${t("voice.bubble.mark", { defaultValue: "Voz" })}`}
              </T>
            )}
          </XStack>
        )}
      </YStack>
    </YStack>
  )
}
