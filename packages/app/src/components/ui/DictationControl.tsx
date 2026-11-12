/**
 * DictationControl — the chat composer's audio (dictation) control, extracted
 * so every text field in the OS carries THE SAME control, not a copy (Pablo,
 * 2026-10-30: "la UI debería ser exactamente la misma UI que tenemos en este
 * campo"). The composer renders it inside its pill (engine = its own recording
 * session); the To Do note boxes (blocked reply, send-back) render it at the
 * end of their field row (engine = `useDictationEngine`, the shared hook).
 *
 * Behaviour contract (the composer's, verbatim):
 *   idle        → quiet mic glyph; tap starts a take.
 *   starting    → the same mic with a spinner (the permission prompt is open);
 *                 the field it sits in stays visible and editable.
 *   recording   → discard X + red pause + live waveform + m:ss counter. The
 *                 field it sits in is expected to step aside (the composer
 *                 swaps the textarea for this row).
 *   stopped     → discard X + play/pause + frozen waveform (seekable) + the
 *                 pencil. NOTHING is sent — the pencil transcribes and hands
 *                 the text to the engine, and the FIELD's own send button is
 *                 the only thing that submits.
 *   transcribing→ spinner on the pencil; everything else inert.
 *
 * The engine is injected (`DictationEngine`) so the composer keeps its own
 * recording session (drafts, pending-audio persistence, Fast Refresh
 * survival) while rendering the identical visuals.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View as RNView } from "react-native"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"
import { expandSamples, formatDuration } from "../InputComposer.audio"
import {
  useVoiceNote,
  type VoiceNoteAudio,
  type VoiceNoteErrorCode,
  type VoiceNoteState,
} from "../../hooks/voice/useVoiceNote"
import { TerosLoading } from "../TerosLoading"
import { IconBtn, Ph, T } from "./ds"

// Waveform metrics — the composer's `.recorder` bars.
const MIN_BAR_HEIGHT = 4
const MAX_BAR_HEIGHT = 28
const BAR_WIDTH = 3
const BAR_GAP = 2

/** One global rule: the spin keyframes (shared with the composer's loaders). */
const DICTATION_CSS_ID = "teros-dictation-css"
const DICTATION_CSS = `
@keyframes teros-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
`
function useDictationCss() {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(DICTATION_CSS_ID)) return
    const el = document.createElement("style")
    el.id = DICTATION_CSS_ID
    el.textContent = DICTATION_CSS
    document.head.appendChild(el)
  }, [])
}

/** Rotating wrapper for the in-button spinner (the composer's SpinningLoader). */
function SpinningLoader({ size, color }: { size: number; color: string }) {
  return (
    <div style={{ width: size, height: size, animation: "teros-spin 0.9s linear infinite" }}>
      <TerosLoading size={size} color={color} />
    </div>
  )
}

/** The composer's waveform: rolling red bars while live, seekable when stopped. */
function Waveform({
  live,
  samples,
  width,
  playing,
  progress,
  onSeek,
}: {
  live: boolean
  samples: number[]
  width: number
  playing: boolean
  progress: number
  onSeek?: (ratio: number) => void
}) {
  const c = useColors()
  const numBars = Math.max(10, Math.floor(width / (BAR_WIDTH + BAR_GAP)))
  // Live: the last N samples roll in; stopped: stretch what was captured to
  // fill the width (the composer's expandSamples).
  const display = live
    ? samples.slice(-numBars)
    : samples.length > 0
      ? expandSamples(samples.slice(-numBars), numBars)
      : []
  const emptySlots = live ? Math.max(0, numBars - display.length) : 0
  const progressBarIndex = playing ? Math.floor(progress * numBars) : -1
  return (
    <div
      style={{
        flex: 1,
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: BAR_GAP,
        minWidth: 100,
        overflow: "hidden",
        cursor: !live && onSeek ? "pointer" : "default",
      }}
      onClick={
        !live && onSeek
          ? (e) => {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
              onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
            }
          : undefined
      }
    >
      {Array.from({ length: numBars }).map((_, index) => {
        const isEmptySlot = index < emptySlots
        const sampleIndex = index - emptySlots
        const hasSample = !isEmptySlot && sampleIndex < display.length
        const normalizedValue = hasSample ? (display[sampleIndex] ?? 0) : 0
        const barHeight = hasSample
          ? MIN_BAR_HEIGHT + normalizedValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)
          : MIN_BAR_HEIGHT
        let backgroundColor: string
        if (isEmptySlot) {
          backgroundColor = c.borderStrong
        } else if (live) {
          backgroundColor = semanticColors.red
        } else if (progressBarIndex >= 0 && index <= progressBarIndex) {
          backgroundColor = c.accent
        } else {
          backgroundColor = c.tile
        }
        return (
          <div
            key={index}
            style={{
              width: BAR_WIDTH,
              height: barHeight,
              borderRadius: 1.5,
              backgroundColor,
              flexShrink: 0,
            }}
          />
        )
      })}
    </div>
  )
}

/** What a dictation engine drives — the composer's session or `useVoiceNote`. */
export interface DictationEngine {
  state: VoiceNoteState
  /** Elapsed seconds while recording; the take's length once stopped. */
  seconds: number
  /** Live waveform samples (0..1). */
  samples: number[]
  /** The take in hand (stopped/transcribing) — its URL plays back. */
  audio: { url?: string; duration: number } | null
  /** A teardown is in flight — the discard X goes inert. */
  discarding?: boolean
  start(): unknown
  stop(): unknown
  discard(): unknown
  transcribe(): unknown
}

/**
 * The default engine for secondary fields: `useVoiceNote` (the composer's
 * recorder choice + the chat's speech-to-text) adapted to `DictationEngine`.
 * The transcript is handed to `onTranscript` — write it into your field.
 */
export function useDictationEngine({
  onTranscript,
  onError,
}: {
  onTranscript: (text: string) => void
  onError?: (message: string, code: VoiceNoteErrorCode) => void
}): DictationEngine {
  const voice = useVoiceNote({
    onTranscript,
    onError: (message, code) => onError?.(message, code),
  })
  return {
    state: voice.state,
    seconds: voice.seconds,
    samples: voice.samples,
    audio: voice.audio as VoiceNoteAudio | null,
    start: voice.start,
    stop: voice.stop,
    discard: voice.discard,
    transcribe: voice.transcribe,
  }
}

export interface DictationControlProps {
  /** The recording session to drive (composer: its own; fields: useDictationEngine). */
  engine: DictationEngine
  /** Mic size in px (the composer's pill: 36, or 40 compact; note boxes: 28). */
  micSize?: number
  /** Mic glyph size in px (18 in the composer; 16 in the note boxes). */
  iconSize?: number
  /** 28px row buttons (note boxes) instead of the composer's 36px. */
  compact?: boolean
  /** Inert mic (the composer disables it while the agent input is disabled). */
  disabled?: boolean
  /** Override the mic's accessible name (fields pass their own hint). */
  label?: string
  /** Web tooltip on the mic — the composer passes its Alt+X hint. */
  micTitle?: string
  /** Hide the pencil (fields that only want raw audio). Default: shown. */
  hideTranscribe?: boolean
  /** Prefix for the mic/row testIDs (`${testID}-mic` / `${testID}-row`). */
  testID?: string
}

/**
 * The composer's dictation control: the mic in idle/starting, the recording
 * row otherwise. Stopping NEVER submits — see the contract at the top.
 */
export function DictationControl({
  engine,
  micSize = 36,
  iconSize = 18,
  compact,
  disabled,
  label,
  micTitle,
  hideTranscribe,
  testID,
}: DictationControlProps) {
  const { t } = useTranslation()
  const c = useColors()
  useDictationCss()

  const [width, setWidth] = useState(300)
  const containerRef = useRef<HTMLDivElement>(null)
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackProgress, setPlaybackProgress] = useState(0)

  const recording = engine.state === "recording"
  const starting = engine.state === "starting"
  const stopped = engine.state === "stopped"
  const transcribing = engine.state === "transcribing"
  const inRow = recording || stopped || transcribing

  // Measure the waveform box (the composer's ResizeObserver).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [inRow])

  // Playback progress (the composer's rAF loop).
  useEffect(() => {
    if (!isPlaying || !audioPlayerRef.current) return
    let raf = 0
    const update = () => {
      const player = audioPlayerRef.current
      if (player && player.duration > 0) setPlaybackProgress(player.currentTime / player.duration)
      raf = requestAnimationFrame(update)
    }
    update()
    return () => {
      cancelAnimationFrame(raf)
      setPlaybackProgress(0)
    }
  }, [isPlaying])

  // Tear the preview player down with the control.
  useEffect(
    () => () => {
      audioPlayerRef.current?.pause()
      audioPlayerRef.current = null
    },
    [],
  )

  const togglePlayback = useCallback(() => {
    const url = engine.audio?.url
    if (!url) return
    if (isPlaying && audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      setIsPlaying(false)
    } else {
      if (!audioPlayerRef.current || audioPlayerRef.current.src !== url) {
        audioPlayerRef.current?.pause()
        audioPlayerRef.current = new Audio(url)
        audioPlayerRef.current.onended = () => setIsPlaying(false)
      }
      audioPlayerRef.current.play()
      setIsPlaying(true)
    }
  }, [engine.audio?.url, isPlaying])

  const handleTranscribe = useCallback(() => {
    if (transcribing) return
    audioPlayerRef.current?.pause()
    setIsPlaying(false)
    void engine.transcribe()
  }, [transcribing, engine])

  const handleDiscard = useCallback(() => {
    audioPlayerRef.current?.pause()
    audioPlayerRef.current = null
    setIsPlaying(false)
    void engine.discard()
  }, [engine])

  const micAria = label ?? t("conversation.recordVoice", { defaultValue: "Record a voice note" })
  const discardLabel = t("recording.discard", { defaultValue: "Discard" })
  const pauseLabel = t("recording.pause", { defaultValue: "Pause" })
  const playLabel = t("recording.play", { defaultValue: "Play" })
  const transcribeLabel = t("recording.transcribe", { defaultValue: "Transcribe to text" })

  // ── idle / starting: the quiet mic glyph (the composer's `.compose .mic`) ──
  if (!inRow) {
    return (
      <Pressable
        testID={testID ? `${testID}-mic` : "dictation-mic"}
        accessibilityRole="button"
        accessibilityLabel={micAria}
        onPress={() => void engine.start()}
        disabled={disabled}
        {...({ title: micTitle ?? micAria } as object)}
        style={({ pressed }: any) => [
          {
            width: micSize,
            height: micSize,
            borderRadius: 100,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            opacity: disabled ? 0.5 : 1,
            transform: pressed ? [{ scale: 0.94 }] : undefined,
          },
          { cursor: disabled ? "default" : "pointer", transition: "color 0.2s" } as any,
        ]}
      >
        {({ hovered }: any) =>
          starting ? (
            <SpinningLoader size={iconSize} color={semanticColors.red} />
          ) : (
            <Ph name="microphone" size={iconSize} color={hoveredMic(disabled, hovered, c)} />
          )
        }
      </Pressable>
    )
  }

  // ── recording / stopped / transcribing: the composer's `.recorder` row ────
  return (
    <RNView
      testID={testID ? `${testID}-recording` : "dictation-recording"}
      style={{
        flex: 1,
        minWidth: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: 2,
      }}
    >
      <IconBtn
        icon="x"
        plain
        sm={compact}
        onPress={handleDiscard}
        disabled={engine.discarding}
        accessibilityLabel={discardLabel}
        title={discardLabel}
      />
      {recording ? (
        <IconBtn
          icon="pause"
          weight="fill"
          color={semanticColors.red}
          sm={compact}
          onPress={() => void engine.stop()}
          style={{ backgroundColor: c.tint.r.bg, borderColor: "transparent" }}
          accessibilityLabel={pauseLabel}
          title={pauseLabel}
        />
      ) : (
        <IconBtn
          icon={isPlaying ? "pause" : "play"}
          weight="fill"
          color={c.accent}
          sm={compact}
          onPress={togglePlayback}
          disabled={transcribing}
          style={{ backgroundColor: c.navActive, borderColor: "transparent" }}
          accessibilityLabel={playLabel}
          title={playLabel}
        />
      )}
      <RNView ref={containerRef as any} style={{ flex: 1, minWidth: 0 }}>
        <Waveform
          live={recording}
          samples={engine.samples}
          width={width}
          playing={isPlaying}
          progress={playbackProgress}
          onSeek={
            stopped
              ? (ratio) => {
                  const player = audioPlayerRef.current
                  if (player && player.duration) {
                    player.currentTime = ratio * player.duration
                    setPlaybackProgress(ratio)
                  }
                }
              : undefined
          }
        />
      </RNView>
      <T
        step="code13"
        color={recording ? semanticColors.red : c.accent}
        style={{ minWidth: 36, textAlign: "right", fontVariant: ["tabular-nums"] }}
      >
        {formatDuration(engine.audio?.duration ?? engine.seconds)}
      </T>
      {!hideTranscribe &&
        (transcribing ? (
          <RNView
            accessibilityLabel={t("todo.voice.transcribing")}
            aria-disabled
            style={{
              width: compact ? 28 : 36,
              height: compact ? 28 : 36,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <SpinningLoader size={compact ? 14 : 16} color={c.accent} />
          </RNView>
        ) : (
          <IconBtn
            icon="pencil-simple-line"
            plain
            sm={compact}
            onPress={handleTranscribe}
            accessibilityLabel={transcribeLabel}
            title={transcribeLabel}
          />
        ))}
    </RNView>
  )
}

/** The mic glyph's colour: text on hover, text3 at rest (the composer's). */
function hoveredMic(disabled: boolean | undefined, hovered: boolean, c: ReturnType<typeof useColors>) {
  if (disabled) return c.text3
  return hovered ? c.text : c.text3
}
