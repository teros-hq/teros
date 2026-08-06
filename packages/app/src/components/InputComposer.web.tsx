import {
  AlertCircle,
  FileText,
  Loader,
  Mic,
  Paperclip,
  Pause,
  PenLine,
  Play,
  Send,
  Upload,
  X,
} from "@tamagui/lucide-icons"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import RecordRTC, { StereoAudioRecorder } from "recordrtc"
import { Button, Image, Input, Text, View, XStack, YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors, controlsBar, indicators, surface } from "./mca/primitives/colors"
import { type UploadedFile, useFileUpload } from "../hooks/useFileUpload"
import { StopButton } from "./chat/StopButton"
import { STORAGE_KEYS, storage } from "../services/storage"
import { useAudioStore, getPendingAudio } from "../store/audioStore"
import { useTilingStore } from "../store/tilingStore"
import { TerosLoading } from "./TerosLoading"
import { useToast } from "./Toast"
import {
  assembleBlob,
  calculateMetering,
  expandSamples,
  formatDuration,
  normalizeMetering,
} from "./InputComposer.audio"
import { createFileDropHandlers } from "./InputComposer.dnd"

type WebRecordingState = "idle" | "recording" | "paused"

// Unified audio recording interface for both web and native
export interface AudioRecording {
  uri?: string // Native: file URI
  blob?: Blob // Web: Blob object
  duration: number // seconds
  url?: string // Object URL for playback (web)
}

interface RecordingErrorInfo {
  type: "permission_denied" | "not_found" | "not_supported" | "interrupted" | "unknown"
  details?: string // Technical details for debugging
}

type RecordingError = RecordingErrorInfo | null

interface InputComposerProps {
  onSend: (
    text: string,
    audio?: AudioRecording,
    files?: UploadedFile[],
  ) => Promise<{ success: boolean }>
  onTranscribe?: (audio: AudioRecording) => Promise<string>
  disabled?: boolean
  placeholder?: string
  channelId?: string // For saving/restoring drafts
  /** Tiling window ID — used to check if this composer is in the active window for Alt+X */
  windowId?: string
  isGenerating?: boolean
  onStop?: (kind: "soft" | "hard" | "queue_only") => void | Promise<void>
  hasIrreversibleToolInFlight?: boolean
  irreversibleToolName?: string
}

// Re-export UploadedFile type for consumers
export type { UploadedFile }

const TEXTAREA_MIN_HEIGHT = 40 // pixels
const TEXTAREA_MAX_HEIGHT = 150 // pixels

// Waveform constants
const MIN_BAR_HEIGHT = 4
const MAX_BAR_HEIGHT = 28
const BAR_WIDTH = 3
const BAR_GAP = 2

/**
 * Rotating wrapper for small in-button spinners. TerosLoading's dot pulse is
 * imperceptible at icon sizes (~20px), so spin the whole glyph with a CSS
 * animation (web only — this file never renders on native).
 */
function SpinningLoader({ size, color }: { size: number; color: string }) {
  useEffect(() => {
    if (document.getElementById("teros-spin-keyframes")) return
    const style = document.createElement("style")
    style.id = "teros-spin-keyframes"
    style.textContent =
      "@keyframes teros-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }"
    document.head.appendChild(style)
  }, [])

  return (
    <div style={{ width: size, height: size, animation: "teros-spin 0.9s linear infinite" }}>
      <TerosLoading size={size} color={color} />
    </div>
  )
}

function stopNativeRecorder(recorder: MediaRecorder, chunks: Blob[]): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve(assembleBlob(chunks))
      return
    }
    recorder.addEventListener("stop", () => resolve(assembleBlob(chunks)), { once: true })
    recorder.stop()
  })
}

export function InputComposer({
  onSend,
  onTranscribe,
  disabled = false,
  placeholder,
  channelId,
  windowId,
  isGenerating = false,
  onStop,
  hasIrreversibleToolInFlight = false,
  irreversibleToolName,
}: InputComposerProps) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const resolvedPlaceholder = placeholder ?? t("conversation.typeMessage")
  const [text, setText] = useState("")
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [useMultilineLayout, setUseMultilineLayout] = useState(false)

  // File upload hook
  const fileUpload = useFileUpload()
  // Stable ref so handleSend doesn't need fileUpload in its deps array
  // (fileUpload returns a new object every render via ...state spread)
  const fileUploadRef = useRef(fileUpload)
  useEffect(() => {
    fileUploadRef.current = fileUpload
  })

  // Load draft from storage when channelId changes
  useEffect(() => {
    if (!channelId) return

    const loadDraft = async () => {
      try {
        const drafts = await storage.get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS)
        if (drafts?.[channelId]) {
          setText(drafts[channelId])
        }
      } catch (e) {
        console.error("Failed to load draft:", e)
      }
    }

    loadDraft()
  }, [channelId])

  // Save draft to storage when text changes (debounced)
  useEffect(() => {
    if (!channelId) return

    const saveDraft = async () => {
      try {
        const drafts =
          (await storage.get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS)) ?? {}

        if (text.trim()) {
          drafts[channelId] = text
        } else {
          delete drafts[channelId] // Remove empty drafts
        }

        await storage.set(STORAGE_KEYS.MESSAGE_DRAFTS, drafts)
      } catch (e) {
        console.error("Failed to save draft:", e)
      }
    }

    // Debounce to avoid too many writes
    const timeoutId = setTimeout(saveDraft, 500)
    return () => clearTimeout(timeoutId)
  }, [text, channelId])

  // Restore pending audio from audioStore on channel change
  const restoredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!channelId || restoredRef.current === channelId) return
    const pending = getPendingAudio(channelId)
    if (!pending) return
    restoredRef.current = channelId
    try {
      const binaryStr = atob(pending.base64Data)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const blob = new Blob([bytes], { type: pending.mimeType })
      const url = URL.createObjectURL(blob)
      setAudioRecording({ blob, duration: pending.duration, url })
      setRecordingState("paused")
      setRecordingDuration(pending.duration)
    } catch (e) {
      console.error("[InputComposer] Failed to restore audio from store:", e)
      useAudioStore.getState().clearPendingAudio(channelId)
    }
  }, [channelId])

  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_MIN_HEIGHT)
  const [recordingState, setRecordingState] = useState<WebRecordingState>("idle")
  // Transitional UI states: mic pressed but getUserMedia/recorder not ready
  // yet, and X pressed but teardown not finished yet. Both show a spinner on
  // the corresponding button so the tap gives immediate feedback.
  const [isStartingRecording, setIsStartingRecording] = useState(false)
  const [isDiscarding, setIsDiscarding] = useState(false)
  // Send pressed but the message hasn't left yet (file upload, recorder stop
  // + blob assembly, WS round-trip). Shows a spinner on the send button and
  // guards against double sends.
  const [isSending, setIsSending] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [audioRecording, setAudioRecording] = useState<AudioRecording | null>(null)
  const [recordingError, setRecordingError] = useState<RecordingError>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [metering, setMetering] = useState<number>(-60)
  const [playbackProgress, setPlaybackProgress] = useState<number>(0)

  // Hover states for buttons that need icon color changes
  const [isMicHovered, setIsMicHovered] = useState(false)
  const [isAttachHovered, setIsAttachHovered] = useState(false)
  const [isDiscardHovered, setIsDiscardHovered] = useState(false)
  const [isPlaybackHovered, setIsPlaybackHovered] = useState(false)
  const [isRecPauseHovered, setIsRecPauseHovered] = useState(false)
  const [isTranscribeHovered, setIsTranscribeHovered] = useState(false)

  // Waveform samples
  const [samples, setSamples] = useState<number[]>([])
  const [waveformWidth, setWaveformWidth] = useState(300)
  const waveformContainerRef = useRef<HTMLDivElement>(null)

  const recorderRef = useRef<RecordRTC | MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const recordingDurationRef = useRef(0)
  const lastMeteringRef = useRef<number | null>(null)
  const meteringCountRef = useRef<number>(0)

  // Input refs - declared here (before any useEffect that uses them) to avoid TDZ issues
  const singleLineInputRef = useRef<any>(null)
  const multiLineInputRef = useRef<any>(null)
  const textRef = useRef(text)
  const pendingCursorRef = useRef<number | null>(null)
  const useMultilineLayoutRef = useRef(useMultilineLayout)
  const containerRef = useRef<any>(null)

  // Determine if this composer is in the currently active tiling window.
  // When windowId is provided, we check the tiling store: the window must be
  // the active tab in its container AND that container must be the active one.
  // When windowId is absent (e.g. non-tiling usage), we default to true.
  const isActiveWindow = useTilingStore(
    useCallback(
      (state) => {
        if (!windowId) return true
        const win = state.windows[windowId]
        if (!win) return true
        const desktop = state.desktops[state.activeDesktopIndex]
        if (!desktop?.layout) return true
        // Active container on the current desktop
        if (desktop.activeContainerId !== win.containerId) return false
        // Active tab within that container
        const layout = desktop.layout
        const findContainer = (node: any): any => {
          if (!node) return null
          if (node.type === "container") return node.id === win.containerId ? node : null
          return findContainer(node.first) || findContainer(node.second)
        }
        const container = findContainer(layout)
        return container?.activeWindowId === windowId
      },
      [windowId],
    ),
  )

  // Keep refs in sync with state
  useEffect(() => {
    textRef.current = text
  }, [text])

  useEffect(() => {
    useMultilineLayoutRef.current = useMultilineLayout
  }, [useMultilineLayout])

  // Calculate number of bars based on container width
  const numBars = Math.max(10, Math.floor(waveformWidth / (BAR_WIDTH + BAR_GAP)))

  const hasText = text.trim().length > 0
  const hasFileAttachment = fileUpload.selectedFiles.length > 0
  const isRecording = recordingState === "recording"
  const isPaused = recordingState === "paused"
  const isRecordingOrPaused = recordingState !== "idle"
  const hasAudioRecording = audioRecording !== null

  // --- Drag-and-drop de archivos sobre el composer (web only) ---
  // Reutiliza el pipeline de attachments existente: soltar archivos equivale a
  // fileUpload.addFiles(), igual que el file picker. RN-Web no reenvía los
  // eventos drag de forma fiable vía props, así que enganchamos listeners
  // nativos sobre el nodo DOM del contenedor (mismo patrón que el Kanban en
  // windows/BoardWindow/KanbanColumn.tsx).
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  // Guard leído desde un ref para no recrear el efecto de listeners en cada
  // render (el contador anti-parpadeo vive dentro de createFileDropHandlers).
  const dropDisabledRef = useRef(false)
  dropDisabledRef.current = disabled || isRecordingOrPaused

  useEffect(() => {
    const el = containerRef.current as HTMLElement | null
    if (!el) return

    const handlers = createFileDropHandlers({
      isDropDisabled: () => dropDisabledRef.current,
      setDragging: setIsDraggingFiles,
      onFiles: (files) => fileUploadRef.current.addFiles(files),
    })

    el.addEventListener("dragenter", handlers.onDragEnter)
    el.addEventListener("dragover", handlers.onDragOver)
    el.addEventListener("dragleave", handlers.onDragLeave)
    el.addEventListener("drop", handlers.onDrop)
    return () => {
      el.removeEventListener("dragenter", handlers.onDragEnter)
      el.removeEventListener("dragover", handlers.onDragOver)
      el.removeEventListener("dragleave", handlers.onDragLeave)
      el.removeEventListener("drop", handlers.onDrop)
    }
  }, [])

  // Measure waveform container width
  useEffect(() => {
    const container = waveformContainerRef.current
    if (!container) return

    const updateWidth = () => {
      const width = container.offsetWidth
      if (width > 0) {
        setWaveformWidth(width)
      }
    }

    // Initial measurement
    updateWidth()

    const resizeObserver = new ResizeObserver(() => {
      updateWidth()
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [isRecordingOrPaused])

  // Keep duration ref in sync
  useEffect(() => {
    recordingDurationRef.current = recordingDuration
  }, [recordingDuration])

  // Helper to get the native DOM element from Tamagui ref
  const getNativeInput = useCallback(
    (tamaguiRef: any): HTMLInputElement | HTMLTextAreaElement | null => {
      if (!tamaguiRef) return null
      if (tamaguiRef instanceof HTMLInputElement || tamaguiRef instanceof HTMLTextAreaElement) {
        return tamaguiRef
      }
      if (tamaguiRef.tagName === "INPUT" || tamaguiRef.tagName === "TEXTAREA") {
        return tamaguiRef
      }
      const native = tamaguiRef.querySelector?.("input, textarea")
      if (native) return native
      if (tamaguiRef.native) return tamaguiRef.native
      return tamaguiRef
    },
    [],
  )

  // Switch to multiline layout when input overflows, go back to inline only when empty.
  // Once in multiline, stay there — don't re-evaluate overflow on every render to
  // avoid oscillation caused by ChatView re-renders (e.g. feature-flag store hydration).
  useEffect(() => {
    if (text.length === 0 && useMultilineLayout) {
      setUseMultilineLayout(false)
      return
    }

    // Already multiline — stay there until text is cleared.
    if (useMultilineLayout) return

    // Use the native DOM <input> element (not the Tamagui wrapper) so that
    // scrollWidth/clientWidth reflect actual text metrics. The wrapper may have
    // flex layout quirks that make scrollWidth > clientWidth even when empty.
    const nativeInput = getNativeInput(singleLineInputRef.current)
    if (nativeInput && nativeInput.scrollWidth > nativeInput.clientWidth + 2) {
      setUseMultilineLayout(true)
    }
  }, [text, useMultilineLayout, getNativeInput])

  // Calculate metering from analyser during recording
  useEffect(() => {
    if (recordingState !== "recording" || !analyser) {
      return
    }

    let animationFrameId: number

    const updateMetering = () => {
      const db = calculateMetering(analyser)
      setMetering(db)
      animationFrameId = requestAnimationFrame(updateMetering)
    }

    updateMetering()

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [recordingState, analyser])

  // Collect samples during recording
  useEffect(() => {
    if (recordingState !== "recording") return
    if (metering === lastMeteringRef.current) return

    lastMeteringRef.current = metering
    const normalizedValue = normalizeMetering(metering)

    meteringCountRef.current += 1
    if (meteringCountRef.current % 2 !== 0) return

    setSamples((prev) => {
      const newSamples = [...prev]
      if (newSamples.length < numBars) {
        newSamples.push(normalizedValue)
      } else {
        newSamples.shift()
        newSamples.push(normalizedValue)
      }
      return newSamples
    })
  }, [recordingState, metering, numBars])

  // Reset samples when starting new recording
  useEffect(() => {
    if (recordingState === "recording" && samples.length === 0) {
      meteringCountRef.current = 0
    } else if (recordingState === "idle") {
      setSamples([])
      meteringCountRef.current = 0
    }
  }, [recordingState, samples.length])

  // Start recording timer
  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setRecordingDuration((prev) => prev + 1)
    }, 1000)
  }, [])

  // Stop recording timer
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // iOS/Safari: AudioContext gets suspended when switching tabs.
  // Detect this via visibilitychange + audioContext statechange.
  // MediaRecorder: save what we have and transition to 'paused'.
  // RecordRTC: cancel (it can't produce partial data reliably).
  useEffect(() => {
    if (recordingState !== "recording") return

    const handleInterruption = () => {
      stopTimer()
      setAnalyser(null)
      const recorder = recorderRef.current

      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioContextRef.current) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }

      if (recorder instanceof MediaRecorder) {
        if (recorder.state === "inactive") {
          const blob = assembleBlob(chunksRef.current)
          if (blob && blob.size > 0) {
            const url = URL.createObjectURL(blob)
            setAudioRecording({ blob, duration: recordingDurationRef.current, url })
            setRecordingState("paused")
          } else {
            setRecordingState("idle")
            setRecordingDuration(0)
            setSamples([])
            setRecordingError({ type: "interrupted" })
          }
          return
        }
        const handleStop = () => {
          recorder.removeEventListener("stop", handleStop)
          const blob = assembleBlob(chunksRef.current)
          if (blob && blob.size > 0) {
            const url = URL.createObjectURL(blob)
            setAudioRecording({ blob, duration: recordingDurationRef.current, url })
            setRecordingState("paused")
          } else {
            setRecordingState("idle")
            setRecordingDuration(0)
            setSamples([])
            setRecordingError({ type: "interrupted" })
          }
        }
        recorder.addEventListener("stop", handleStop)
        recorder.stop()
      } else {
        if (recorder) {
          ;(recorder as RecordRTC).stopRecording(() => {})
          recorderRef.current = null
        }
        setRecordingState("idle")
        setRecordingDuration(0)
        setSamples([])
        setRecordingError({ type: "interrupted" })
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        handleInterruption()
      }
    }

    // AudioContext.statechange fires before visibilitychange on iOS,
    // so it catches the case where iOS suspends audio without hiding the page.
    const handleAudioContextStateChange = () => {
      const ctx = audioContextRef.current
      // 'interrupted' is iOS-only; 'suspended' covers other browsers
      if (ctx && (ctx.state === "suspended" || (ctx.state as string) === "interrupted")) {
        handleInterruption()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    audioContextRef.current?.addEventListener("statechange", handleAudioContextStateChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      audioContextRef.current?.removeEventListener("statechange", handleAudioContextStateChange)
    }
  }, [recordingState, stopTimer])

  // Track playback progress
  useEffect(() => {
    if (!isPlaying || !audioPlayerRef.current) {
      return
    }

    let animationFrameId: number

    const updateProgress = () => {
      const player = audioPlayerRef.current
      if (player && player.duration > 0) {
        setPlaybackProgress(player.currentTime / player.duration)
      }
      animationFrameId = requestAnimationFrame(updateProgress)
    }

    updateProgress()

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
      setPlaybackProgress(0)
    }
  }, [isPlaying])

  // Start audio recording with RecordRTC
  const startRecording = useCallback(async () => {
    setRecordingError(null)

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("[Recording] getUserMedia not supported")
      setRecordingError({
        type: "not_supported",
        details: "navigator.mediaDevices.getUserMedia is not available",
      })
      return
    }

    setIsStartingRecording(true)
    try {
      console.log("[Recording] Requesting microphone access...")
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      console.log("[Recording] Microphone access granted")

      // Set up Web Audio API for visualization
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
        if (AudioContextClass) {
          const audioContext = new AudioContextClass()
          audioContextRef.current = audioContext

          if (audioContext.state === "suspended") {
            await audioContext.resume()
          }

          const source = audioContext.createMediaStreamSource(stream)
          const analyserNode = audioContext.createAnalyser()
          analyserNode.fftSize = 256
          analyserNode.smoothingTimeConstant = 0.7
          source.connect(analyserNode)
          setAnalyser(analyserNode)
          console.log("[Recording] Audio analyser set up")
        }
      } catch (e) {
        console.warn("[Recording] Could not set up audio analyser:", e)
      }

      const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || isIOS
      const useNativeRecorder = isSafari && typeof MediaRecorder !== "undefined"

      if (useNativeRecorder) {
        const mimeType = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm"
        chunksRef.current = []
        const mediaRecorder = new MediaRecorder(stream, { mimeType })
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorderRef.current = mediaRecorder
        mediaRecorder.start(5000)
        console.log("[Recording] Started recording with MediaRecorder (%s)", mimeType)
      } else {
        const recorder = new RecordRTC(stream, {
          type: "audio",
          mimeType: isIOS ? "audio/wav" : "audio/webm",
          recorderType: StereoAudioRecorder,
          numberOfAudioChannels: 1,
          desiredSampRate: 16000,
          disableLogs: false,
        })
        recorderRef.current = recorder
        recorder.startRecording()
        console.log("[Recording] Started recording with RecordRTC")
      }

      setRecordingState("recording")
      setRecordingDuration(0)
      setSamples([])
      startTimer()
    } catch (error: any) {
      console.error("[Recording] Failed to start recording:", error)

      let errorDetails: string
      try {
        const errorInfo = {
          name: error?.name,
          message: error?.message,
          stack: error?.stack?.split("\n").slice(0, 3).join(" | "),
          toString: String(error),
          keys: error ? Object.keys(error) : [],
          type: typeof error,
        }
        errorDetails = JSON.stringify(errorInfo, null, 0)
      } catch {
        errorDetails = String(error)
      }

      if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
        setRecordingError({ type: "permission_denied", details: errorDetails })
      } else if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
        setRecordingError({ type: "not_found", details: errorDetails })
      } else if (error?.name === "NotSupportedError") {
        setRecordingError({ type: "not_supported", details: errorDetails })
      } else {
        setRecordingError({ type: "unknown", details: errorDetails })
      }
    } finally {
      setIsStartingRecording(false)
    }
  }, [startTimer])

  // Stop and finalize recording (pause)
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return

    stopTimer()
    setAnalyser(null)

    if (recorder instanceof MediaRecorder) {
      const handleStop = () => {
        recorder.removeEventListener("stop", handleStop)
        const blob = assembleBlob(chunksRef.current)
        if (blob) {
          const url = URL.createObjectURL(blob)
          setAudioRecording({ blob, duration: recordingDurationRef.current, url })
          console.log("[Recording] Recording stopped, blob size:", blob.size)
        }
      }
      recorder.addEventListener("stop", handleStop)
      if (recorder.state !== "inactive") recorder.stop()
      else handleStop()
    } else {
      recorder.stopRecording(() => {
        const blob = recorder.getBlob()
        if (blob) {
          const url = URL.createObjectURL(blob)
          setAudioRecording({ blob, duration: recordingDurationRef.current, url })
          console.log("[Recording] Recording stopped, blob size:", blob.size)

          if (channelId) {
            blob
              .arrayBuffer()
              .then((buf) => {
                const bytes = new Uint8Array(buf)
                let binary = ""
                for (let i = 0; i < bytes.byteLength; i++) {
                  binary += String.fromCharCode(bytes[i])
                }
                useAudioStore.getState().savePendingAudio(channelId, {
                  base64Data: btoa(binary),
                  mimeType: blob.type || "audio/webm",
                  duration: recordingDurationRef.current,
                  timestamp: Date.now(),
                })
              })
              .catch((e) => console.warn("[InputComposer] Failed to persist audio:", e))
          }
        }
      })
    }

    streamRef.current?.getTracks().forEach((track) => track.stop())
    setRecordingState("paused")

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
  }, [stopTimer])

  // Discard recording
  const discardRecording = useCallback(() => {
    setIsDiscarding(true)
    // Defer the teardown one frame so the spinner paints before the
    // recorder/track cleanup (which can briefly block the main thread) runs.
    requestAnimationFrame(() => {
      if (recorderRef.current instanceof MediaRecorder) {
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop()
        recorderRef.current = null
        chunksRef.current = []
      } else if (recorderRef.current) {
        ;(recorderRef.current as RecordRTC).stopRecording(() => {})
        recorderRef.current = null
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())

      if (audioRecording?.url) {
        URL.revokeObjectURL(audioRecording.url)
      }

      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause()
        audioPlayerRef.current = null
      }

      if (audioContextRef.current) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }

      setAnalyser(null)
      setRecordingState("idle")
      setRecordingDuration(0)
      setAudioRecording(null)
      setIsPlaying(false)
      setSamples([])
      stopTimer()
      if (channelId) useAudioStore.getState().clearPendingAudio(channelId)
      setIsDiscarding(false)
    })
  }, [audioRecording?.url, stopTimer, channelId])

  // Transcribe recording → populate text input
  const handleTranscribe = useCallback(async () => {
    if (!onTranscribe || isTranscribing) return

    let recording = audioRecording

    // If still recording, stop first to get the blob
    if (recordingState === "recording" && recorderRef.current) {
      stopTimer()
      setAnalyser(null)
      const recorder = recorderRef.current

      if (recorder instanceof MediaRecorder) {
        const blob = await stopNativeRecorder(recorder, chunksRef.current)
        recording = blob
          ? { blob, duration: recordingDurationRef.current, url: URL.createObjectURL(blob) }
          : null
      } else {
        recording = await new Promise<AudioRecording | null>((resolve) => {
          recorder.stopRecording(() => {
            const blob = recorder.getBlob()
            if (blob) {
              resolve({
                blob,
                duration: recordingDurationRef.current,
                url: URL.createObjectURL(blob),
              })
            } else {
              resolve(null)
            }
          })
        })
      }

      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioContextRef.current) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }

      if (!recording) return
      setAudioRecording(recording)
      setRecordingState("paused")

      if (channelId && recording.blob) {
        recording.blob
          .arrayBuffer()
          .then((buf) => {
            const bytes = new Uint8Array(buf)
            let binary = ""
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
            useAudioStore.getState().savePendingAudio(channelId, {
              base64Data: btoa(binary),
              mimeType: recording!.blob!.type || "audio/webm",
              duration: recording!.duration,
              timestamp: Date.now(),
            })
          })
          .catch((e) => console.warn("[InputComposer] Failed to persist audio:", e))
      }
    }

    if (!recording) return

    setIsTranscribing(true)
    try {
      const transcribedText = await onTranscribe(recording)
      // Exit recording mode, populate text input
      if (recording.url) URL.revokeObjectURL(recording.url)
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause()
        audioPlayerRef.current = null
      }
      setAudioRecording(null)
      setRecordingState("idle")
      setRecordingDuration(0)
      setIsPlaying(false)
      setSamples([])
      setText(transcribedText)
      if (channelId) useAudioStore.getState().clearPendingAudio(channelId)
    } catch (error: any) {
      const message = error?.message || "Transcription failed. Please try again."
      setRecordingError({ type: "unknown", details: message })
      toast.error(t("recording.transcribeFailed"))
    } finally {
      setIsTranscribing(false)
    }
  }, [onTranscribe, isTranscribing, audioRecording, recordingState, stopTimer, toast, t])

  // Play/pause audio preview
  const togglePlayback = useCallback(() => {
    if (!audioRecording?.url) return

    if (isPlaying && audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      setIsPlaying(false)
    } else {
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new Audio(audioRecording.url)
        audioPlayerRef.current.onended = () => setIsPlaying(false)
      }
      audioPlayerRef.current.play()
      setIsPlaying(true)
    }
  }, [audioRecording?.url, isPlaying])

  // Seek in audio
  const handleWaveformClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!audioRecording?.url || !audioPlayerRef.current) return

      const rect = e.currentTarget.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const percentage = clickX / rect.width

      if (audioPlayerRef.current.duration) {
        audioPlayerRef.current.currentTime = percentage * audioPlayerRef.current.duration
        setPlaybackProgress(percentage)
      }
    },
    [audioRecording?.url],
  )

  // Dismiss error
  const dismissError = useCallback(() => {
    setRecordingError(null)
  }, [])

  // Handle send
  const handleSend = useCallback(async () => {
    const fileUpload = fileUploadRef.current
    const hasContentToSend =
      text.trim().length > 0 ||
      audioRecording !== null ||
      recordingState === "recording" ||
      fileUpload.selectedFiles.length > 0
    if (!hasContentToSend || disabled || isSending) return

    setIsSending(true)

    let uploadedFiles: UploadedFile[] | undefined
    if (fileUpload.selectedFiles.length > 0 && fileUpload.uploadedFiles.length === 0) {
      const result = await fileUpload.upload()
      if (result.length > 0) {
        uploadedFiles = result
      } else {
        setIsSending(false)
        return
      }
    } else if (fileUpload.uploadedFiles.length > 0) {
      uploadedFiles = fileUpload.uploadedFiles
    }

    let recordingToSend: AudioRecording | undefined = audioRecording || undefined

    // If still recording, stop first to get the blob. Awaited (like
    // handleTranscribe) so isSending — and the send-button spinner — cover
    // the whole flow and onSend fires exactly once.
    if (recordingState === "recording" && recorderRef.current) {
      stopTimer()
      setAnalyser(null)
      const recorder = recorderRef.current

      let blob: Blob | null
      if (recorder instanceof MediaRecorder) {
        blob = await stopNativeRecorder(recorder, chunksRef.current)
      } else {
        blob = await new Promise<Blob | null>((resolve) => {
          recorder.stopRecording(() => resolve(recorder.getBlob()))
        })
      }

      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioContextRef.current) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }

      if (!blob) {
        setIsSending(false)
        return
      }

      recordingToSend = {
        blob,
        duration: recordingDurationRef.current,
        url: URL.createObjectURL(blob),
      }
      // Paused preview stays visible while the send is in flight; if onSend
      // fails the audio remains recoverable instead of being dropped
      setAudioRecording(recordingToSend)
      setRecordingState("paused")
    }

    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current = null
    }

    const result = await onSend(text.trim(), recordingToSend, uploadedFiles)

    if (result.success) {
      if (recordingToSend?.url) {
        setTimeout(() => URL.revokeObjectURL(recordingToSend!.url!), 1000)
      }

      setText("")
      setAudioRecording(null)
      setRecordingState("idle")
      setRecordingDuration(0)
      setIsPlaying(false)
      setMetering(-60)
      setPlaybackProgress(0)
      setSamples([])
      fileUpload.clear()

      if (channelId) {
        useAudioStore.getState().clearPendingAudio(channelId)
        storage
          .get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS)
          .then((drafts) => {
            const updated = drafts ?? {}
            delete updated[channelId]
            storage.set(STORAGE_KEYS.MESSAGE_DRAFTS, updated)
          })
          .catch((e) => console.error("Failed to clear draft:", e))
      }
    } else {
      if (recordingToSend) {
        toast.error(t("recording.sendFailed"))
      }
    }

    setIsSending(false)
    // fileUpload intentionally excluded: accessed via fileUploadRef to keep handleSend stable
  }, [
    disabled,
    isSending,
    recordingState,
    stopTimer,
    text,
    audioRecording,
    onSend,
    channelId,
    toast,
    t,
  ])

  // Attach native keydown listener
  useEffect(() => {
    const handleNativeKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const singleInput = getNativeInput(singleLineInputRef.current)
      const multiInput = getNativeInput(multiLineInputRef.current)

      // Alt+X: shortcut to toggle voice recording (only fires in the active tiling window)
      if (e.altKey && e.code === "KeyX") {
        e.preventDefault()
        e.stopPropagation()
        if (!isActiveWindow) return
        if (recordingState === "idle") {
          startRecording()
        } else if (recordingState === "recording") {
          handleSend()
        } else if (recordingState === "paused") {
          startRecording()
        }
        return
      }

      if (target !== singleInput && target !== multiInput) {
        return
      }

      if (e.key === "Enter") {
        if (e.shiftKey || e.ctrlKey) {
          e.preventDefault()
          e.stopPropagation()

          const input = target as HTMLInputElement | HTMLTextAreaElement
          const start = input.selectionStart ?? textRef.current.length
          const end = input.selectionEnd ?? textRef.current.length
          const newText =
            textRef.current.substring(0, start) + "\n" + textRef.current.substring(end)
          const newCursorPos = start + 1

          if (!useMultilineLayoutRef.current) {
            pendingCursorRef.current = newCursorPos
            setUseMultilineLayout(true)
          }

          setText(newText)

          if (useMultilineLayoutRef.current) {
            requestAnimationFrame(() => {
              const currentInput = getNativeInput(multiLineInputRef.current)
              if (currentInput) {
                currentInput.setSelectionRange(newCursorPos, newCursorPos)
              }
            })
          }
          return
        }

        if (textRef.current.trim().length > 0 || audioRecording !== null) {
          e.preventDefault()
          handleSend()
        }
        return
      }

      if (e.key === "Escape" && recordingState !== "idle") {
        e.preventDefault()
        discardRecording()
      }
    }

    document.addEventListener("keydown", handleNativeKeyDown, true)
    return () => {
      document.removeEventListener("keydown", handleNativeKeyDown, true)
    }
  }, [
    audioRecording,
    recordingState,
    handleSend,
    discardRecording,
    getNativeInput,
    startRecording,
    stopRecording,
  ])

  // (Alt+X guard is now handled via isActiveWindow from useTilingStore — no pointerdown tracking needed)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimer()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioRecording?.url) {
        URL.revokeObjectURL(audioRecording.url)
      }
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause()
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      if (recorderRef.current instanceof MediaRecorder) {
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop()
        chunksRef.current = []
      } else if (recorderRef.current) {
        ;(recorderRef.current as RecordRTC).stopRecording(() => {})
      }
    }
  }, [stopTimer, audioRecording?.url])

  // Get error message for display
  const getErrorMessage = (error: RecordingError): { message: string; details?: string } => {
    if (!error) return { message: "" }

    const baseMessages: Record<string, string> = {
      permission_denied: t("recording.micDenied"),
      not_found: t("recording.micNotFound"),
      not_supported: t("recording.notSupported"),
      interrupted: t("recording.interrupted"),
      unknown: t("recording.failed"),
    }

    return {
      message: baseMessages[error.type] || baseMessages["unknown"],
      details: error.details,
    }
  }

  // Error banner — memoized for the same reason as waveform (avoid inline component type churn)
  const errorBanner = useMemo(() => {
    if (!recordingError) return null

    const { message, details } = getErrorMessage(recordingError)

    return (
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="flex-start"
        justifyContent="space-between"
        backgroundColor={controlsBar.deny.bg}
        borderBottomWidth={1}
        borderBottomColor={controlsBar.deny.border}
      >
        <YStack flex={1} gap="$1">
          <XStack alignItems="center" gap="$2">
            <AlertCircle size={16} color={semanticColors.red} />
            <Text fontSize="$2" color={semanticColors.red} flex={1}>
              {message}
            </Text>
          </XStack>
          {details && (
            <Text
              fontSize="$1"
              color={semanticColors.red}
              opacity={0.7}
              paddingLeft="$5"
              userSelect="text"
              cursor="text"
              style={{ userSelect: "text", WebkitUserSelect: "text" } as any}
            >
              {details}
            </Text>
          )}
        </YStack>
        <Button
          size="$2"
          circular
          chromeless
          onPress={dismissError}
          icon={<X size={14} color={semanticColors.red} />}
        />
      </XStack>
    )
  }, [recordingError, dismissError])

  // Waveform — memoized to prevent it from being a new component type on every render.
  // Defining a component inline (const Foo = () => ...) causes React to unmount+remount
  // it every render, which re-fires the ResizeObserver and can trigger setState loops.
  const waveform = useMemo(() => {
    const displaySamples = isRecording
      ? samples
      : isPaused && samples.length > 0
        ? expandSamples(samples, numBars)
        : []

    const progressBarIndex = isPlaying ? Math.floor(playbackProgress * numBars) : -1
    const emptySlots = isRecording ? Math.max(0, numBars - displaySamples.length) : 0

    return (
      <div
        ref={waveformContainerRef}
        onClick={isPaused ? handleWaveformClick : undefined}
        style={{
          flex: 1,
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: BAR_GAP,
          cursor: isPaused ? "pointer" : "default",
          minWidth: 100,
          overflow: "hidden",
        }}
      >
        {Array.from({ length: numBars }).map((_, index) => {
          const isEmptySlot = index < emptySlots
          const sampleIndex = index - emptySlots
          const hasSample = !isEmptySlot && sampleIndex < displaySamples.length
          const normalizedValue = hasSample ? (displaySamples[sampleIndex] ?? 0) : 0
          const barHeight = hasSample
            ? MIN_BAR_HEIGHT + normalizedValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)
            : MIN_BAR_HEIGHT

          let backgroundColor: string
          if (isEmptySlot) {
            backgroundColor = c.border
          } else if (isRecording) {
            backgroundColor = semanticColors.red
          } else if (progressBarIndex >= 0 && index <= progressBarIndex) {
            backgroundColor = semanticColors.indigo
          } else {
            backgroundColor = semanticColors.indigoGlow
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, isPaused, isPlaying, samples, numBars, playbackProgress, handleWaveformClick])

  // Can send logic
  const canSend = (hasText || hasAudioRecording || isRecording || hasFileAttachment) && !disabled

  // Auto-resize textarea
  useEffect(() => {
    if (!useMultilineLayout) {
      setTextareaHeight(TEXTAREA_MIN_HEIGHT)
      return
    }

    const inputWrapper = multiLineInputRef.current
    if (!inputWrapper) return

    const textarea =
      inputWrapper.tagName === "TEXTAREA"
        ? inputWrapper
        : inputWrapper.querySelector?.("textarea") || inputWrapper

    if (!textarea || !textarea.scrollHeight) return

    textarea.style.height = "auto"
    const scrollHeight = textarea.scrollHeight
    const newHeight = Math.min(Math.max(scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT)
    textarea.style.height = `${newHeight}px`
    setTextareaHeight(newHeight)
  }, [text, useMultilineLayout])

  // Transfer focus when layout changes
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const timer = setTimeout(() => {
        const refEl = useMultilineLayout ? multiLineInputRef.current : singleLineInputRef.current
        const inputEl = getNativeInput(refEl)

        if (inputEl) {
          inputEl.focus()
          const cursorPos = pendingCursorRef.current ?? textRef.current.length
          pendingCursorRef.current = null
          if (inputEl.setSelectionRange) {
            inputEl.setSelectionRange(cursorPos, cursorPos)
          }
        }
      }, 0)
      return () => clearTimeout(timer)
    })
    return () => cancelAnimationFrame(raf)
  }, [useMultilineLayout, getNativeInput])

  // Focus input when clicking container
  const handleContainerPress = useCallback(
    (e?: unknown) => {
      if (isRecordingOrPaused) return // Don't focus input in recording mode

      // Presses on buttons (mic, attach, send…) bubble up to this container.
      // Focusing the input for them flashes the mobile keyboard open for an
      // instant before the button's own action takes over — skip those.
      const domTarget = ((e as { nativeEvent?: { target?: unknown }; target?: unknown })
        ?.nativeEvent?.target ?? (e as { target?: unknown })?.target) as HTMLElement | undefined
      if (
        typeof domTarget?.closest === "function" &&
        domTarget.closest('button, [role="button"]')
      ) {
        return
      }

      const refEl = useMultilineLayout ? multiLineInputRef.current : singleLineInputRef.current
      const inputEl = getNativeInput(refEl)
      if (inputEl) {
        inputEl.focus()
      }
    },
    [useMultilineLayout, getNativeInput, isRecordingOrPaused],
  )

  // Render different layouts based on state
  const renderContent = () => {
    // Recording or Paused: Show waveform layout
    if (isRecordingOrPaused) {
      return (
        <XStack testID="composer-recording" padding={4} alignItems="center" gap="$2">
          {/* Left group: Discard + Pause/Play */}
          <Button
            width={52}
            height={52}
            padding={0}
            borderRadius={12}
            backgroundColor={c.bgInner}
            borderWidth={1}
            borderColor={c.border}
            onPress={discardRecording}
            disabled={isDiscarding}
            onMouseEnter={() => setIsDiscardHovered(true)}
            onMouseLeave={() => setIsDiscardHovered(false)}
            hoverStyle={{
              backgroundColor: c.bgCardHover,
              borderColor: c.borderStrong,
            }}
            pressStyle={{
              backgroundColor: c.bgInner,
              borderColor: c.borderStrong,
              scale: 0.95,
            }}
            icon={
              isDiscarding ? (
                <SpinningLoader size={18} color={c.text2} />
              ) : (
                <X size={18} color={isDiscardHovered ? c.text2 : c.text3} />
              )
            }
          />

          {isRecording ? (
            <Button
              width={52}
              height={52}
              padding={0}
              borderRadius={12}
              backgroundColor={indicators.irreversible.bg}
              borderWidth={1}
              borderColor={indicators.irreversible.border}
              onPress={stopRecording}
              onMouseEnter={() => setIsRecPauseHovered(true)}
              onMouseLeave={() => setIsRecPauseHovered(false)}
              hoverStyle={{
                backgroundColor: controlsBar.deny.border,
                borderColor: controlsBar.deny.border,
              }}
              pressStyle={{
                backgroundColor: controlsBar.deny.bg,
                borderColor: controlsBar.deny.border,
                scale: 0.95,
              }}
              icon={<Pause size={20} color={isRecPauseHovered ? semanticColors.red : semanticColors.red} />}
            />
          ) : (
            <Button
              width={52}
              height={52}
              padding={0}
              borderRadius={12}
              backgroundColor={semanticColors.indigoGlow}
              borderWidth={1}
              borderColor={c.badges.info.border}
              onPress={togglePlayback}
              onMouseEnter={() => setIsPlaybackHovered(true)}
              onMouseLeave={() => setIsPlaybackHovered(false)}
              hoverStyle={{
                backgroundColor: c.badges.info.bg,
                borderColor: c.badges.info.border,
              }}
              pressStyle={{
                backgroundColor: c.badges.info.bg,
                borderColor: c.badges.info.border,
                scale: 0.95,
              }}
              icon={
                isPlaying ? (
                  <Pause size={20} color={isPlaybackHovered ? semanticColors.indigoLight : semanticColors.indigo} />
                ) : (
                  <Play size={20} color={isPlaybackHovered ? semanticColors.indigoLight : semanticColors.indigo} />
                )
              }
            />
          )}

          {/* Waveform + Duration */}
          <XStack flex={1} alignItems="center" gap="$2" minWidth={0}>
            {waveform}
            <Text
              fontSize={13}
              fontWeight="500"
              color={isRecording ? semanticColors.red : semanticColors.indigo}
              minWidth={36}
              textAlign="right"
              fontVariant={["tabular-nums"]}
            >
              {formatDuration(audioRecording?.duration || recordingDuration)}
            </Text>
          </XStack>

          {/* Right group: Transcribe (optional) + Send */}
          {onTranscribe && (
            <Button
              width={52}
              height={52}
              padding={0}
              borderRadius={12}
              backgroundColor={c.bgInner}
              borderWidth={1}
              borderColor={c.border}
              onPress={handleTranscribe}
              disabled={isTranscribing}
              onMouseEnter={() => setIsTranscribeHovered(true)}
              onMouseLeave={() => setIsTranscribeHovered(false)}
              hoverStyle={{
                backgroundColor: c.bgCard,
                borderColor: c.borderStrong,
              }}
              pressStyle={{
                backgroundColor: c.bgCard,
                borderColor: c.borderStrong,
                scale: 0.95,
              }}
              disabledStyle={{
                opacity: 0.5,
              }}
              icon={
                isTranscribing ? (
                  <Loader size={18} color={c.text2} />
                ) : (
                  <PenLine size={18} color={isTranscribeHovered ? c.text2 : c.text3} />
                )
              }
            />
          )}

          <Button
            width={52}
            height={52}
            padding={0}
            borderRadius={12}
            backgroundColor={semanticColors.indigo}
            borderWidth={1}
            borderColor={c.badges.info.border}
            onPress={handleSend}
            disabled={isSending}
            hoverStyle={{
              backgroundColor: semanticColors.indigoLight,
              borderColor: c.badges.info.border,
            }}
            pressStyle={{
              backgroundColor: semanticColors.indigoDark,
              borderColor: c.badges.info.border,
              scale: 0.95,
            }}
            icon={
              isSending ? (
                <SpinningLoader size={20} color={surface.dark.text} />
              ) : (
                <Send size={20} color={surface.dark.text} />
              )
            }
          />
        </XStack>
      )
    }

    const stopButton =
      isGenerating && onStop ? (
        <StopButton
          onSoftStop={() => onStop("soft")}
          onHardStop={() => onStop("hard")}
          hasIrreversibleToolInFlight={hasIrreversibleToolInFlight}
          irreversibleToolName={irreversibleToolName}
        />
      ) : null
    const sendButton = (
      <Button
        testID="composer-send"
        width={52}
        height={52}
        padding={0}
        borderRadius={12}
        backgroundColor={semanticColors.indigo}
        borderWidth={1}
        borderColor={c.badges.info.border}
        onPress={handleSend}
        disabled={!canSend || isSending}
        hoverStyle={{
          backgroundColor: semanticColors.indigoLight,
          borderColor: c.badges.info.border,
        }}
        pressStyle={{
          backgroundColor: semanticColors.indigoDark,
          borderColor: c.badges.info.border,
          scale: 0.95,
        }}
        disabledStyle={{
          backgroundColor: c.badges.info.bg,
          borderColor: c.border,
        }}
        icon={
          isSending ? (
            <SpinningLoader size={20} color={surface.dark.text} />
          ) : (
            <Send size={20} color={surface.dark.text} />
          )
        }
      />
    )
    const micButton = (
      <Button
        testID="composer-mic"
        width={52}
        height={52}
        padding={0}
        borderRadius={12}
        backgroundColor={c.bgInner}
        borderWidth={1}
        borderColor={c.border}
        onPress={startRecording}
        disabled={disabled || isStartingRecording}
        onMouseEnter={() => setIsMicHovered(true)}
        onMouseLeave={() => setIsMicHovered(false)}
        hoverStyle={{
          backgroundColor: controlsBar.deny.bg,
          borderColor: controlsBar.deny.bg,
        }}
        pressStyle={{
          backgroundColor: controlsBar.deny.bg,
          borderColor: controlsBar.deny.border,
          scale: 0.95,
        }}
        icon={
          isStartingRecording ? (
            <SpinningLoader size={20} color={semanticColors.red} />
          ) : (
            <Mic size={20} color={isMicHovered ? semanticColors.red : c.text3} />
          )
        }
      />
    )

    const hasInputContent = hasText || hasFileAttachment
    // Stop lives in the left section alongside Attach; the right slot is
    // dedicated to the primary action (send/mic). Recording flows replace
    // the whole composer, so stopButton naturally hides during audio capture.
    const rightButton = hasInputContent ? sendButton : micButton

    if (useMultilineLayout) {
      return (
        <>
          <YStack paddingHorizontal={4} paddingTop={4}>
            <Input
              testID="composer-input"
              ref={multiLineInputRef}
              backgroundColor="transparent"
              borderWidth={0}
              outlineWidth={0}
              focusStyle={{ borderWidth: 0, outlineWidth: 0 }}
              paddingHorizontal="$2"
              paddingVertical="$1"
              fontSize="$4"
              fontFamily="$body"
              color={c.text}
              placeholderTextColor={c.text3}
              placeholder={resolvedPlaceholder}
              value={text}
              onChangeText={setText}
              multiline
              disabled={disabled}
              autoComplete="new-password"
              autoCorrect={false}
              spellCheck={false}
              enterKeyHint="send"
              height={textareaHeight}
              maxHeight={TEXTAREA_MAX_HEIGHT}
              overflow="hidden"
              style={
                {
                  overflowY: textareaHeight >= TEXTAREA_MAX_HEIGHT ? "auto" : "hidden",
                  overflowX: "hidden",
                } as any
              }
            />
          </YStack>
          <XStack padding={4} alignItems="center" justifyContent="space-between">
            <XStack alignItems="center" gap="$2">
              <Button
                testID="composer-attach"
                width={52}
                height={52}
                padding={0}
                borderRadius={12}
                backgroundColor={
                  hasFileAttachment ? semanticColors.indigoGlow : c.bgInner
                }
                borderWidth={1}
                borderColor={hasFileAttachment ? c.badges.info.border : c.border}
                onPress={fileUpload.pickFile}
                disabled={disabled || fileUpload.isUploading}
                onMouseEnter={() => setIsAttachHovered(true)}
                onMouseLeave={() => setIsAttachHovered(false)}
                hoverStyle={
                  hasFileAttachment
                    ? {
                        backgroundColor: c.badges.info.bg,
                        borderColor: c.badges.info.border,
                      }
                    : {
                        backgroundColor: c.bgCardHover,
                        borderColor: c.borderStrong,
                      }
                }
                pressStyle={
                  hasFileAttachment
                    ? {
                        backgroundColor: c.badges.info.bg,
                        borderColor: c.badges.info.border,
                        scale: 0.95,
                      }
                    : {
                        backgroundColor: c.bgInner,
                        borderColor: c.borderStrong,
                        scale: 0.95,
                      }
                }
                icon={
                  <Paperclip
                    size={20}
                    color={
                      hasFileAttachment
                        ? isAttachHovered
                          ? semanticColors.indigoLight
                          : semanticColors.indigo
                        : isAttachHovered
                          ? c.text2
                          : c.text3
                    }
                  />
                }
              />
              {stopButton}
            </XStack>
            {rightButton}
          </XStack>
        </>
      )
    }

    // Single line layout
    return (
      <XStack padding={4} alignItems="center" gap="$2">
        <Button
          testID="composer-attach"
          width={52}
          height={52}
          padding={0}
          borderRadius={12}
          backgroundColor={hasFileAttachment ? semanticColors.indigoGlow : c.bgInner}
          borderWidth={1}
          borderColor={hasFileAttachment ? c.badges.info.border : c.border}
          onPress={fileUpload.pickFile}
          disabled={disabled || fileUpload.isUploading}
          onMouseEnter={() => setIsAttachHovered(true)}
          onMouseLeave={() => setIsAttachHovered(false)}
          hoverStyle={
            hasFileAttachment
              ? {
                  backgroundColor: c.badges.info.bg,
                  borderColor: c.badges.info.border,
                }
              : {
                  backgroundColor: c.bgCardHover,
                  borderColor: c.borderStrong,
                }
          }
          pressStyle={
            hasFileAttachment
              ? {
                  backgroundColor: c.badges.info.bg,
                  borderColor: c.badges.info.border,
                  scale: 0.95,
                }
              : {
                  backgroundColor: c.bgInner,
                  borderColor: c.borderStrong,
                  scale: 0.95,
                }
          }
          icon={
            <Paperclip
              size={20}
              color={
                hasFileAttachment
                  ? isAttachHovered
                    ? semanticColors.indigoLight
                    : semanticColors.indigo
                  : isAttachHovered
                    ? c.text2
                    : c.text3
              }
            />
          }
        />
        {stopButton}
        <Input
          testID="composer-input"
          ref={singleLineInputRef}
          flex={1}
          backgroundColor="transparent"
          borderWidth={0}
          outlineWidth={0}
          focusStyle={{ borderWidth: 0, outlineWidth: 0 }}
          paddingHorizontal="$2"
          paddingVertical="$1"
          fontSize="$4"
          fontFamily="$body"
          color={c.text}
          placeholderTextColor={c.text3}
          placeholder={resolvedPlaceholder}
          value={text}
          onChangeText={setText}
          disabled={disabled}
          autoComplete="new-password"
          autoCorrect={false}
          spellCheck={false}
          enterKeyHint="send"
        />
        {rightButton}
      </XStack>
    )
  }

  return (
    <YStack
      ref={containerRef}
      marginHorizontal={4}
      marginTop={4}
      // No bottom margin and no bottom rounding: the composer rests on the
      // safe-zone band (#0a0a0a, where the gradient ends) and reads as a
      // sheet that continues to the physical bottom edge of the screen.
      borderTopLeftRadius={16}
      borderTopRightRadius={16}
      // overflow hidden: the error banner and the attachment preview paint
      // edge-to-edge backgrounds that would poke out of the rounded corners.
      overflow="hidden"
      backgroundColor={c.bgCard}
      // Subtle top-to-bottom gradient, lighter at the top and fading into
      // #0a0a0a (the canvas / bottom safe-zone color) so the composer blends
      // into the gesture-bar band. Web only; the backgroundColor above stays
      // as a fallback.
      style={{
        background: `linear-gradient(to bottom, ${c.bgCard}, ${c.bgPage})`,
      }}
      onPress={handleContainerPress}
      cursor={isRecordingOrPaused ? "default" : "text"}
    >
      {errorBanner}

      {/* File attachment preview — also shown when there's only a validation error
          (all files rejected), otherwise the error would be swallowed silently. */}
      {(hasFileAttachment || fileUpload.error) && (
        <YStack
          padding="$3"
          gap="$2"
          backgroundColor={semanticColors.indigoGlow}
          borderBottomWidth={1}
          borderBottomColor={c.border}
        >
          {fileUpload.selectedFiles.map((file, idx) => {
            const previewUrl = fileUpload.previewUrls[idx]
            const isImage = file.type.startsWith("image/")
            return (
              <XStack
                key={`${file.name}-${idx}`}
                testID="composer-attach-chip"
                alignItems="center"
                gap="$2"
                flex={1}
                padding="$2"
                backgroundColor={c.bgInner}
                borderRadius={6}
              >
                {isImage && previewUrl ? (
                  <Image
                    source={{ uri: previewUrl }}
                    width={40}
                    height={40}
                    borderRadius={4}
                    resizeMode="cover"
                  />
                ) : (
                  <YStack
                    width={40}
                    height={40}
                    borderRadius={4}
                    backgroundColor={semanticColors.indigoGlow}
                    alignItems="center"
                    justifyContent="center"
                  >
                    <FileText size={20} color={semanticColors.indigo} />
                  </YStack>
                )}

                <YStack flex={1}>
                  <Text fontSize="$3" color={c.text} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text fontSize="$2" color={c.text3}>
                    {fileUpload.isUploading
                      ? `Uploading... ${fileUpload.progress}%`
                      : `${(file.size / 1024).toFixed(1)} KB`}
                  </Text>
                </YStack>

                <Button
                  testID="composer-attach-remove"
                  size="$2"
                  circular
                  chromeless
                  onPress={() => fileUpload.removeFile(idx)}
                  disabled={fileUpload.isUploading}
                  icon={<X size={14} color={c.text3} />}
                />
              </XStack>
            )
          })}
          {fileUpload.error && (
            <Text fontSize="$2" color={semanticColors.red} padding="$2">
              {fileUpload.error}
            </Text>
          )}
          {fileUpload.selectedFiles.length > 0 && (
            <Button
              size="$2"
              chromeless
              onPress={fileUpload.clear}
              disabled={fileUpload.isUploading}
              icon={<X size={14} color={c.text3} />}
            >
              Clear all
            </Button>
          )}
        </YStack>
      )}

      {renderContent()}

      {/* Overlay de drag-and-drop: se muestra al arrastrar archivos externos
          sobre el composer. pointerEvents="none" para no robar el 'drop' al
          contenedor (los listeners viven en el YStack padre). Reutiliza la
          paleta cyan del preview de attachments. */}
      {isDraggingFiles && (
        <YStack
          testID="composer-drop-overlay"
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={10}
          pointerEvents="none"
          alignItems="center"
          justifyContent="center"
          gap="$2"
          borderTopLeftRadius={16}
          borderTopRightRadius={16}
          borderWidth={2}
          borderStyle="dashed"
          borderColor={c.badges.info.border}
          backgroundColor={c.badges.info.bg}
          animation="quick"
          enterStyle={{ opacity: 0 }}
        >
          <Upload size={28} color={semanticColors.indigo} />
          <Text fontSize="$4" fontWeight="600" color={semanticColors.indigo}>
            {t("conversation.dropFilesHere")}
          </Text>
        </YStack>
      )}
    </YStack>
  )
}
