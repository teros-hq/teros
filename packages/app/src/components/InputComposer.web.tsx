import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import RecordRTC, { StereoAudioRecorder } from "recordrtc"
import { Pressable, ScrollView, TextInput, View as RNView } from "react-native"
import { Image, Text, View, XStack, YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors, surface } from "./mca/primitives/colors"
import { FONT_SANS } from "./mca/primitives/fonts"
import { type UploadedFile, useFileUpload } from "../hooks/useFileUpload"
import { StopButton } from "./chat/StopButton"
import { STORAGE_KEYS, storage } from "../services/storage"
import { useAudioStore, getPendingAudio } from "../store/audioStore"
import { useRecordingSessionStore, getRecordingEngine, startEngineTimer, stopEngineTimer, cleanupEngine, destroyRecordingSession } from "../store/recordingSessionStore"
import { useTilingStore } from "../store/tilingStore"
import { TerosLoading } from "./TerosLoading"
import { useToast } from "./Toast"
import { getTerosClient } from "../services/terosClientSingleton"
import type { AgentAppData } from "../services/AgentApi"
import { ChipBtn, IconBtn, Ph, T } from "./ui/ds"
import { Halo } from "./ui/ds/Halo"
import { THREAD_MAX_WIDTH, useChatPane } from "./chat/bubbles"
import {
  assembleBlob,
  blobToBase64,
  calculateMetering,
  expandSamples,
  formatDuration,
  normalizeMetering,
  shouldBlockUnload,
} from "./InputComposer.audio"
import { createFileDropHandlers } from "./InputComposer.dnd"
import { createPasteHandler } from "./InputComposer.paste"
import { useAtMention, type MentionResource } from "../hooks/useAtMention"
import { MentionDropdown } from "./mention/MentionDropdown"
import { MentionChip } from "./mention/MentionChip"
import { fx } from "../styles/fx"
import { backendUrl } from "../config/runtime"

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
    skillIds?: string[],
  ) => Promise<{ success: boolean }>
  onTranscribe?: (audio: AudioRecording) => Promise<string>
  disabled?: boolean
  placeholder?: string
  channelId?: string // For saving/restoring drafts
  /** Pre-filled text on mount (the Home ask box hands its question over). */
  initialText?: string
  /** Tiling window ID — used to check if this composer is in the active window for Alt+X */
  windowId?: string
  isGenerating?: boolean
  onStop?: (kind: "soft" | "hard" | "queue_only") => void | Promise<void>
  hasIrreversibleToolInFlight?: boolean
  irreversibleToolName?: string
  /** Agent ID for the current chat — used to filter on-demand skills in the @mention dropdown */
  agentId?: string
  /** Agent display name — the "{name} can use" line under the pill. */
  agentName?: string
  /** Workspace — scopes the agent's app list under the pill. */
  workspaceId?: string
  /**
   * ≥1 message in the conversation → the tools row (".compose-meta" apps) is
   * replaced by the contextual suggested-prompt chips (TER composer prompts).
   */
  hasMessages?: boolean
  /** Contextual follow-up prompts (backend-generated after each agent turn). */
  suggestedPrompts?: string[]
  /** Bottom safe-area inset (native parity; web pads the composer with it). */
  bottomInset?: number
}

// Re-export UploadedFile type for consumers
export type { UploadedFile }

const TEXTAREA_MIN_HEIGHT = 24 // pixels — `.compose textarea { height: 24px }`
const TEXTAREA_MAX_HEIGHT = 160 // pixels — `.compose textarea { max-height: 160px }`
const COMPOSE_CONTROL = 40 // the round plus/mic controls inside the pill
const COMPOSE_PILL_RADIUS = (COMPOSE_CONTROL + 8) / 2 // 4px padding above and below

// `.compose textarea::placeholder` is smaller than the text (13px vs 16px) —
// RN-web has no placeholder font-size prop, so one global rule does it.
const COMPOSE_CSS_ID = "teros-compose-css"
function installComposeCss(text3: string) {
  if (typeof document === "undefined") return
  let el = document.getElementById(COMPOSE_CSS_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = COMPOSE_CSS_ID
    document.head.appendChild(el)
  }
  el.textContent = `
    [data-compose="field"] input::placeholder, [data-compose="field"] textarea::placeholder { font-size: 13px; color: ${text3}; opacity: 1; }
    [data-compose="field"] input, [data-compose="field"] textarea { caret-color: #6F27FF; }
    @keyframes teros-mic-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    [data-compose="meta"]::-webkit-scrollbar { display: none; }
  `
}

// ── The agent's apps for the "{name} can use" row (`.compose-meta`) ──────────
// Cached per (agent, workspace) for a minute — the composer remounts often.
const APPS_TTL_MS = 60 * 1000
const appsCache = new Map<string, { apps: AgentAppData[]; expires: number }>()
const appsInFlight = new Map<string, Promise<AgentAppData[]>>()
function fetchAgentApps(agentId: string, workspaceId?: string): Promise<AgentAppData[]> {
  const key = `${agentId}|${workspaceId ?? ""}`
  const cached = appsCache.get(key)
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.apps)
  const inFlight = appsInFlight.get(key)
  if (inFlight) return inFlight
  const req = (async () => {
    try {
      const [apps, systemIds] = await Promise.all([
        getTerosClient().getAgentApps(agentId, workspaceId),
        fetchSystemMcaIds(),
      ])
      // System / preinstalled MCAs (scheduler, memory, guide…) are plumbing,
      // not something the user "gave" the agent — keep the row to real apps.
      // `app.list-catalog` omits HIDDEN system MCAs, so the first-party
      // `mca.teros.*` prefix is the fallback for those.
      const usable = (apps ?? []).filter(
        (a) =>
          a.hasAccess !== false && !systemIds.has(a.mcaId) && !a.mcaId?.startsWith("mca.teros."),
      )
      appsCache.set(key, { apps: usable, expires: Date.now() + APPS_TTL_MS })
      return usable
    } catch {
      return []
    } finally {
      appsInFlight.delete(key)
    }
  })()
  appsInFlight.set(key, req)
  return req
}
/** mcaIds the catalog marks as system (`availability.system` or the
 *  `system` category). Cached once per session — the catalog barely changes. */
let systemMcaIdsPromise: Promise<Set<string>> | null = null
function fetchSystemMcaIds(): Promise<Set<string>> {
  if (systemMcaIdsPromise) return systemMcaIdsPromise
  systemMcaIdsPromise = (async () => {
    try {
      const { catalog } = await getTerosClient().app.listCatalog()
      return new Set(
        (catalog ?? [])
          .filter((m: any) => m?.availability?.system || m?.category === "system")
          .map((m: any) => m.mcaId as string),
      )
    } catch {
      systemMcaIdsPromise = null
      return new Set<string>()
    }
  })()
  return systemMcaIdsPromise
}

function appIconUrl(app: AgentAppData): string | undefined {
  if (app.icon) return app.icon
  if (!app.mcaId) return undefined
  const base = backendUrl()
  return `${base}/static/mcas/${app.mcaId}/icon.svg`
}

// Waveform constants
const MIN_BAR_HEIGHT = 4
const MAX_BAR_HEIGHT = 28
const BAR_WIDTH = 3
const BAR_GAP = 2

// ── File type helpers for attachment preview ────────────────────────────────
type FileKind = "image" | "pdf" | "txt" | "md" | "csv" | "xlsx" | "pptx" | "docx" | "default"

const FILE_KIND_CONFIG: Record<
  FileKind,
  {
    icon: string
    color: string
    bg: string
    label: string
    ext: string
  }
> = {
  image: {
    icon: "image",
    color: semanticColors.purple300,
    bg: semanticColors.purpleGlow,
    label: "Image",
    ext: "IMG",
  },
  pdf: {
    icon: "file-pdf",
    color: semanticColors.red,
    bg: "rgba(239,68,68,0.12)",
    label: "PDF Document",
    ext: "PDF",
  },
  txt: {
    icon: "file-text",
    color: "#60A5FA",
    bg: "rgba(96,165,250,0.10)",
    label: "Text File",
    ext: "TXT",
  },
  md: {
    icon: "file-code",
    color: "#C084FC",
    bg: "rgba(192,132,252,0.10)",
    label: "Markdown",
    ext: "MD",
  },
  csv: {
    icon: "file-csv",
    color: "#4ADE80",
    bg: "rgba(74,222,128,0.10)",
    label: "CSV Data",
    ext: "CSV",
  },
  xlsx: {
    icon: "file-xls",
    color: "#4ADE80",
    bg: "rgba(74,222,128,0.10)",
    label: "Spreadsheet",
    ext: "XLSX",
  },
  pptx: {
    icon: "file-ppt",
    color: "#FB923C",
    bg: "rgba(251,146,60,0.10)",
    label: "Presentation",
    ext: "PPTX",
  },
  docx: {
    icon: "file-doc",
    color: "#93C5FD",
    bg: "rgba(147,197,253,0.10)",
    label: "Word Document",
    ext: "DOCX",
  },
  default: {
    icon: "file",
    color: semanticColors.purple300,
    bg: semanticColors.purpleGlow,
    label: "File",
    ext: "",
  },
}

function getFileKind(file: File): FileKind {
  const name = file.name.toLowerCase()
  const type = file.type
  if (type.startsWith("image/")) return "image"
  if (name.endsWith(".pdf") || type === "application/pdf") return "pdf"
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "md"
  if (name.endsWith(".csv") || type === "text/csv") return "csv"
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || type.includes("spreadsheet")) return "xlsx"
  if (name.endsWith(".pptx") || name.endsWith(".ppt") || type.includes("presentation"))
    return "pptx"
  if (
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    type.includes("wordprocessing") ||
    type.includes("msword")
  )
    return "docx"
  if (name.endsWith(".txt") || type === "text/plain") return "txt"
  return "default"
}

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
  initialText,
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
  agentId,
  agentName,
  workspaceId,
  hasMessages = false,
  suggestedPrompts,
  bottomInset = 0,
}: InputComposerProps) {
  const { t } = useTranslation()
  const c = useColors()
  const pane = useChatPane()
  const openWindow = useTilingStore((s) => s.openWindow)
  const toast = useToast()
  const resolvedPlaceholder = placeholder ?? t("conversation.typeMessage")
  // Contextual suggestion chips (only rendered when hasMessages) — normalized
  // once so the render block below deals with a plain string[].
  const suggestions = hasMessages ? (suggestedPrompts ?? []) : []
  const [text, setText] = useState(initialText ?? "")
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isFocused, setIsFocused] = useState(false)

  useEffect(() => {
    installComposeCss(c.text3)
  }, [c.text3])

  // `.compose-meta` — the apps this agent can use (chips under the pill).
  const [agentApps, setAgentApps] = useState<AgentAppData[]>([])
  useEffect(() => {
    if (!agentId) {
      setAgentApps([])
      return
    }
    let cancelled = false
    fetchAgentApps(agentId, workspaceId).then((apps) => {
      if (!cancelled) setAgentApps(apps)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, workspaceId])

  // ── @mention / skill dropdown ──────────────────────────────────────────────
  // Filter: only show skills with loadMode === 'on-demand' in the dropdown.
  // If agentId is available we could additionally filter by agent-assigned skills,
  // but the backend already silently discards non-assigned ones. For now we
  // show all on-demand skills from the workspace.
  const mention = useAtMention({
    resourceFilter: (r) => {
      // Only allow skills in the dropdown; everything else is hidden for the
      // skill-injection flow (TER-618). If we ever want full @mentions, remove
      // this filter.
      if (r.type !== "skill") return false
      return r.loadMode === "on-demand"
    },
  })

  // When a skill is selected, replace the trigger text with a zero-width space
  // (invisible separator) so the chip can be rendered inline and the user can
  // keep typing. The chip stores the skillId for extraction at send time.
  // Not wrapped in useCallback because MentionDropdown has no memoization that
  // would benefit from a stable reference; the mention object changes every render.
  const handleSelectMention = (resource: MentionResource) => {
    mention.onSelectResource(resource)
    // Replace the "@query" text with an invisible separator so the chip renders
    // inline and the cursor is positioned after it.
    const pos = mention.triggerPos
    if (pos >= 0) {
      const before = text.slice(0, pos)
      const after = text.slice(pos + 1 + mention.query.length) // +1 for the '@'
      const newText = before + "\u200B" + after
      setText(newText)
    }
  }

  // Extract skillIds from mention chips for the send payload
  const skillIdsFromChips = useMemo(() => {
    return mention.chips.filter((c) => c.resource.type === "skill").map((c) => c.resource.id)
  }, [mention.chips])

  // Stable ref to mention.clearChips so handleSend doesn't need `mention` in deps
  const clearChipsRef = useRef(mention.clearChips)
  useEffect(() => {
    clearChipsRef.current = mention.clearChips
  }, [mention.clearChips])

  // Stable ref to mention.onInputChange so handleTextChange doesn't need `mention` in deps
  const onInputChangeRef = useRef(mention.onInputChange)
  useEffect(() => {
    onInputChangeRef.current = mention.onInputChange
  }, [mention.onInputChange])

  // Stable ref to mention.onKeyDown so the keydown listener doesn't need `mention` in deps
  const onKeyDownRef = useRef(mention.onKeyDown)
  useEffect(() => {
    onKeyDownRef.current = mention.onKeyDown
  }, [mention.onKeyDown])

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

  // Unified text-change handler: updates state AND feeds the mention detector.
  // We read selectionStart from the active native input so the trigger position
  // is accurate even when the user types in the middle of the text.
  const handleTextChange = useCallback(
    (newText: string) => {
      setText(newText)
      // Defer cursor read to next tick so the DOM has updated selection
      requestAnimationFrame(() => {
        const native = getNativeInput(inputRef.current)
        const cursorPos = native?.selectionStart ?? newText.length
        onInputChangeRef.current(newText, cursorPos)
      })
    },
    [getNativeInput],
  )

  // Suggested-prompt chip tap: append the prompt to whatever is already in the
  // composer (space-separated when non-empty), then focus the field with the
  // caret at the end. NEVER auto-sends — the text stays editable.
  // Guard read from a ref (assigned below, after recordingState is declared)
  // so the callback stays stable across renders.
  const suggestionsDisabledRef = useRef(false)
  const insertSuggestedPrompt = useCallback(
    (prompt: string) => {
      if (suggestionsDisabledRef.current) return
      const current = textRef.current
      const next = current.trim() ? `${current.trimEnd()} ${prompt}` : prompt
      handleTextChange(next)
      requestAnimationFrame(() => {
        const native = getNativeInput(inputRef.current)
        if (native) {
          native.focus()
          const end = next.length
          if (native.setSelectionRange) native.setSelectionRange(end, end)
        }
      })
    },
    [handleTextChange, getNativeInput],
  )

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

  const [recordingState, setRecordingState] = useState<WebRecordingState>("idle")
  // Suggested-prompt guard: chips are inert while disabled or mid-recording.
  // Assigned here (after recordingState exists) and re-synced every render.
  suggestionsDisabledRef.current = disabled || recordingState !== "idle"
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

  // ── Recording session store sync (Fast Refresh survival) ──────────────
  // The recording engine (MediaRecorder, stream, chunks) lives in a module-level
  // singleton (recordingSessionStore) that survives Fast Refresh remounts.
  // These effects keep the store in sync with the component and re-hydrate
  // the component from the store when it mounts with an active session.

  // Sync local recording state → module store (so the workspace layout can
  // read it for the navigation guard, and the next mount can re-hydrate).
  useEffect(() => {
    const store = useRecordingSessionStore.getState()
    store.setRecordingState(recordingState)
    if (channelId) store.setChannelId(channelId)
    store.setEngineActive(recorderRef.current !== null)
  }, [recordingState, channelId])

  // Sync duration to store (the engine timer also updates it, but this covers
  // the case where the component timer is the one running).
  useEffect(() => {
    useRecordingSessionStore.getState().setDuration(recordingDuration)
  }, [recordingDuration])

  // Re-hydrate from the recording session store on mount (Fast Refresh survival).
  // If the engine has an active recording (state persisted across the remount),
  // restore the component's local state to match.
  const rehydratedRef = useRef(false)
  useEffect(() => {
    if (rehydratedRef.current) return
    rehydratedRef.current = true

    const sessionState = useRecordingSessionStore.getState()
    const engine = getRecordingEngine()

    // Only re-hydrate if the session belongs to this channel
    if (sessionState.channelId !== channelId) return
    if (sessionState.recordingState === 'idle') return

    // Engine has live resources → recording survived a remount
    if (engine.recorder && sessionState.recordingState === 'recording') {
      // Restore refs to point at the surviving engine resources
      recorderRef.current = engine.recorder
      chunksRef.current = engine.chunks
      streamRef.current = engine.stream
      audioContextRef.current = engine.audioContext
      recordingDurationRef.current = engine.durationSeconds

      // Restore UI state
      setRecordingState('recording')
      setRecordingDuration(engine.durationSeconds)
      if (engine.analyserNode) setAnalyser(engine.analyserNode)
      if (engine.samples.length > 0) setSamples(engine.samples)

      // Restart the UI timer (the engine timer is still running, but the
      // component needs its own interval to update local state)
      startTimer()
    } else if (engine.pausedBlob && sessionState.recordingState === 'paused') {
      // Paused recording survived — restore the paused preview
      const url = engine.pausedUrl || URL.createObjectURL(engine.pausedBlob)
      setAudioRecording({ blob: engine.pausedBlob, duration: engine.durationSeconds, url })
      setRecordingState('paused')
      setRecordingDuration(engine.durationSeconds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  // Input refs - declared here (before any useEffect that uses them) to avoid TDZ issues
  // ONE field, always a <textarea>: it starts as a single 24px line and grows
  // with its content up to TEXTAREA_MAX_HEIGHT. (It used to be an <input> that
  // swapped to a <textarea> on overflow — the swap dropped focus, which on
  // phones closed and reopened the keyboard, and the new element never kept
  // the measured height.)
  const inputRef = useRef<any>(null)
  const textRef = useRef(text)
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

  // Calculate number of bars based on container width
  const numBars = Math.max(10, Math.floor(waveformWidth / (BAR_WIDTH + BAR_GAP)))

  const hasText = text.trim().length > 0
  const hasFileAttachment = fileUpload.selectedFiles.length > 0
  const isRecording = recordingState === "recording"
  const isPaused = recordingState === "paused"
  const isRecordingOrPaused = recordingState !== "idle"
  const hasAudioRecording = audioRecording !== null

  // Guard: bloquear el unload de la página mientras haya audio en riesgo
  // (grabando, pausado con blob en mano, o envío en vuelo). Cubre el live
  // reload de Metro en dev y el cierre/refresh accidental en prod. El caso
  // remount por rotación móvil NO dispara beforeunload — ese lo cubre la
  // persistencia del blob en audioStore (ver handleSend).
  useEffect(() => {
    if (!shouldBlockUnload(recordingState, isSending || fileUpload.isUploading)) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = "" // Required for Chrome
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [recordingState, isSending, fileUpload.isUploading])

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

  // --- Paste de imágenes desde el clipboard (web only) ---
  // Capturas de pantalla, imágenes copiadas del navegador, etc. Se extraen
  // como File[] y se entregan al mismo pipeline que el file picker y el
  // drag-and-drop: fileUpload.addFiles(). Si el clipboard tiene texto, el
  // paste sigue su curso normal (no se intercepta).
  //
  // Escuchamos en document (capture) porque el evento paste solo se dispara
  // en el elemento con foco; si el usuario hace click en el composer pero el
  // textarea no tiene foco, el paste no burbujea hasta nuestro contenedor.
  // Filtramos: solo actuamos si el composer contiene el elemento activo.
  useEffect(() => {
    const el = containerRef.current as HTMLElement | null
    if (!el) return

    const handlePaste = createPasteHandler({
      isPasteDisabled: () => {
        if (dropDisabledRef.current) return true
        // Solo interceptar si el foco está dentro del composer.
        return !el.contains(document.activeElement)
      },
      onFiles: (files) => fileUploadRef.current.addFiles(files),
    })

    document.addEventListener("paste", handlePaste, true)
    return () => {
      document.removeEventListener("paste", handlePaste, true)
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
          // Sync to engine singleton for Fast Refresh survival
          getRecordingEngine().analyserNode = analyserNode
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

      // Sync engine resources to the module-level singleton so they survive
      // Fast Refresh remounts (the component's refs die, the singleton's don't).
      const engine = getRecordingEngine()
      engine.recorder = recorderRef.current
      engine.chunks = chunksRef.current
      engine.stream = streamRef.current
      engine.audioContext = audioContextRef.current
      engine.analyserNode = null // set below if analyser was created
      engine.durationSeconds = 0
      engine.samples = []
      engine.pausedBlob = null
      engine.pausedUrl = null
      startEngineTimer()
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

          // Sync paused blob to engine singleton (Fast Refresh survival)
          const engine = getRecordingEngine()
          engine.pausedBlob = blob
          engine.pausedUrl = url

          if (channelId) {
            blobToBase64(blob)
              .then((base64Data) => {
                useAudioStore.getState().savePendingAudio(channelId, {
                  base64Data,
                  mimeType: blob.type || "audio/webm",
                  duration: recordingDurationRef.current,
                  timestamp: Date.now(),
                })
              })
              .catch((e) => console.warn("[InputComposer] Failed to persist audio:", e))
          }
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

          // Sync paused blob to engine singleton (Fast Refresh survival)
          const engine = getRecordingEngine()
          engine.pausedBlob = blob
          engine.pausedUrl = url

          if (channelId) {
            blobToBase64(blob)
              .then((base64Data) => {
                useAudioStore.getState().savePendingAudio(channelId, {
                  base64Data,
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

    // Sync paused state to the engine singleton (Fast Refresh survival)
    const engine = getRecordingEngine()
    engine.durationSeconds = recordingDurationRef.current
    stopEngineTimer()
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
      // Clean the module-level engine singleton (Fast Refresh survival)
      cleanupEngine()
      useRecordingSessionStore.getState().reset()
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

    // Persist the in-flight audio BEFORE the upload: if the page reloads (Metro
    // live reload) or the tree remounts (mobile rotation flips TilingLayout
    // desktop<->mobile) mid-send, the blob survives in audioStore and the
    // composer restores it as 'paused' on next mount — the send is never lost.
    // Cleared on success below (clearPendingAudio) and on discardRecording.
    // Awaited (not fire-and-forget) so the save can't land AFTER the
    // clearPendingAudio of a fast successful send and resurrect a sent audio.
    if (channelId && recordingToSend?.blob) {
      const blob = recordingToSend.blob
      try {
        const base64Data = await blobToBase64(blob)
        useAudioStore.getState().savePendingAudio(channelId, {
          base64Data,
          mimeType: blob.type || "audio/webm",
          duration: recordingToSend.duration,
          timestamp: Date.now(),
        })
      } catch (e) {
        // Persistence is best-effort — a failure here must not block the send.
        console.warn("[InputComposer] Failed to persist in-flight audio:", e)
      }
    }

    const result = await onSend(text.trim(), recordingToSend, uploadedFiles, skillIdsFromChips)

    if (result.success) {
      // Clear mention chips after successful send
      clearChipsRef.current()
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

      // Clean the module-level engine singleton (Fast Refresh survival)
      cleanupEngine()
      useRecordingSessionStore.getState().reset()

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
    skillIdsFromChips,
  ])

  // Attach native keydown listener
  useEffect(() => {
    const handleNativeKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const fieldInput = getNativeInput(inputRef.current)

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

      if (target !== fieldInput) {
        return
      }

      // Mention dropdown keyboard navigation (must be before Enter handling)
      if (onKeyDownRef.current(e.key)) {
        e.preventDefault()
        e.stopPropagation()
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

          setText(newText)
          requestAnimationFrame(() => {
            const currentInput = getNativeInput(inputRef.current)
            if (currentInput) {
              currentInput.setSelectionRange(newCursorPos, newCursorPos)
            }
          })
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
      <RNView
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          paddingVertical: 8,
          paddingLeft: 12,
          paddingRight: 6,
          marginBottom: 8,
          borderRadius: 12,
          backgroundColor: c.tint.r.bg,
          borderWidth: 1,
          borderColor: c.tint.r.bd,
        }}
      >
        <RNView style={{ paddingTop: 2 }}>
          <Ph name="warning-circle" size={15} color={c.tint.r.tx} />
        </RNView>
        <RNView style={{ flex: 1, gap: 2 }}>
          <T step="sm" color={c.tint.r.tx}>
            {message}
          </T>
          {details && (
            <T step="12" color={c.tint.r.tx} selectable style={{ opacity: 0.8 }}>
              {details}
            </T>
          )}
        </RNView>
        <IconBtn icon="x" plain sm color={c.tint.r.tx} onPress={dismissError} />
      </RNView>
    )
  }, [recordingError, dismissError, c])

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
            backgroundColor = c.borderStrong
          } else if (isRecording) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, isPaused, isPlaying, samples, numBars, playbackProgress, handleWaveformClick, c])

  // Can send logic
  const canSend = (hasText || hasAudioRecording || isRecording || hasFileAttachment) && !disabled

  // Auto-grow: the textarea's height is owned by the DOM, not by React — it is
  // measured from scrollHeight after every text change (and on resize) and
  // written inline, so no re-render can reset it. At the cap it scrolls.
  const fitField = useCallback(() => {
    const el = getNativeInput(inputRef.current) as HTMLTextAreaElement | null
    if (!el) return
    el.style.height = "0px"
    const h = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT)
    el.style.height = `${h}px`
    el.style.overflowY = h >= TEXTAREA_MAX_HEIGHT ? "auto" : "hidden"
  }, [getNativeInput])
  useLayoutEffect(() => {
    fitField()
  }, [text, fitField])
  useEffect(() => {
    const el = getNativeInput(inputRef.current)
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => fitField())
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [fitField, getNativeInput])

  // Focus the field on mount — pointer devices only: on a phone a programmatic
  // focus pops the keyboard the moment the chat opens.
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return
    const inputEl = getNativeInput(inputRef.current)
    if (!inputEl) return
    inputEl.focus()
    const end = textRef.current.length
    if (inputEl.setSelectionRange) inputEl.setSelectionRange(end, end)
  }, [getNativeInput])

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

      const inputEl = getNativeInput(inputRef.current)
      if (inputEl) {
        inputEl.focus()
      }
    },
    [getNativeInput, isRecordingOrPaused],
  )

  // ── Pieces of the pill (`.compose`) ─────────────────────────────────────
  const isDark = c.bgPage === surface.dark.bgPage

  // `.compose .plus` — the 38px round control that opens the attachments.
  const plusButton = (
    <Pressable
      testID="composer-attach"
      accessibilityRole="button"
      onPress={fileUpload.pickFile}
      disabled={disabled || fileUpload.isUploading}
      onHoverIn={() => setIsAttachHovered(true)}
      onHoverOut={() => setIsAttachHovered(false)}
      {...({ title: t("conversation.attachFile", { defaultValue: "Attach files" }) } as object)}
      style={({ pressed }) => [
        {
          width: pane.compact ? 40 : 38,
          height: pane.compact ? 40 : 38,
          borderRadius: 100,
          backgroundColor: hasFileAttachment ? c.navActive : c.bgControl,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: disabled ? 0.5 : 1,
          transform: [
            { rotate: hasFileAttachment ? "45deg" : "0deg" },
            { scale: pressed ? 0.94 : 1 },
          ],
        },
        {
          cursor: disabled ? "default" : "pointer",
          transition: "transform 0.4s cubic-bezier(.16,1,.3,1), background 0.25s",
        } as any,
      ]}
    >
      {fileUpload.isUploading ? (
        <SpinningLoader size={16} color={c.text} />
      ) : (
        <Ph
          name="plus"
          size={18}
          color={hasFileAttachment ? c.accent : isDark ? c.text : semanticColors.main800}
        />
      )}
    </Pressable>
  )

  // `.compose .mic` — quiet glyph inside the pill; red + pulsing while recording.
  const micButton = (
    <Pressable
      testID="composer-mic"
      accessibilityRole="button"
      onPress={startRecording}
      disabled={disabled || isStartingRecording}
      onHoverIn={() => setIsMicHovered(true)}
      onHoverOut={() => setIsMicHovered(false)}
      {...({
        title: t("conversation.recordVoice", { defaultValue: "Record a voice note (Alt+X)" }),
      } as object)}
      style={({ pressed }) => [
        {
          width: pane.compact ? 40 : 36,
          height: pane.compact ? 40 : 36,
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
      {isStartingRecording ? (
        <SpinningLoader size={18} color={semanticColors.red} />
      ) : (
        <Ph name="microphone" size={18} color={isMicHovered ? c.text : c.text3} />
      )}
    </Pressable>
  )

  // `.send` — the 48px mint disc (Mint/200 + Mint/400 glyph); disabled = Main/200
  // with a Main/500 glyph and an inset hairline. Visible in every state.
  const sendEnabled = canSend && !isSending
  const disabledBg = isDark ? c.wash2 : semanticColors.main200
  const disabledFg = isDark ? c.text3 : semanticColors.main500
  const disabledRing = isDark ? c.borderStrong : semanticColors.main300
  const sendButton = (
    <Pressable
      testID="composer-send"
      {...fx("send")}
      accessibilityRole="button"
      aria-label={isSending ? "Sending message" : "Send message"}
      onPress={handleSend}
      disabled={!sendEnabled}
      style={({ pressed }) => [
        {
          width: 48,
          height: 48,
          borderRadius: 100,
          backgroundColor: sendEnabled || isSending ? semanticColors.mint200 : disabledBg,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginLeft: 6,
          transform: pressed && sendEnabled ? [{ scale: 0.94 }] : undefined,
        },
        {
          cursor: sendEnabled ? "pointer" : "default",
          // No drop shadow: the live disc blooms under the pointer (Halo).
          boxShadow:
            sendEnabled || isSending
              ? "inset 0 -2px rgba(0,62,49,0.12)"
              : `inset 0 0 0 1px ${disabledRing}`,
          transition:
            "background 0.25s cubic-bezier(.16,1,.3,1), color 0.25s, box-shadow 0.25s, transform 0.3s cubic-bezier(.16,1,.3,1)",
        } as any,
      ]}
    >
      <Halo color={semanticColors.mint200} size="xl" disabled={!sendEnabled} />
      <RNView style={{ zIndex: 1 }}>
        {isSending ? (
          <SpinningLoader size={18} color={semanticColors.mint400} />
        ) : (
          <Ph
            name="arrow-up"
            size={20}
            weight="bold"
            color={sendEnabled ? semanticColors.mint400 : disabledFg}
          />
        )}
      </RNView>
    </Pressable>
  )

  // `.send.stop` — while the agent generates, the ink pill sits next to send
  // (send stays live: a message sent now is queued).
  const stopButton =
    isGenerating && onStop ? (
      <RNView style={{ marginLeft: 6 }}>
        <StopButton
          onSoftStop={() => onStop("soft")}
          onHardStop={() => onStop("hard")}
          hasIrreversibleToolInFlight={hasIrreversibleToolInFlight}
          irreversibleToolName={irreversibleToolName}
        />
      </RNView>
    ) : null

  // Render the inside of the pill based on state
  const renderPillContent = () => {
    // Recording or Paused: waveform layout (`.recorder`)
    if (isRecordingOrPaused) {
      return (
        <XStack
          testID="composer-recording"
          flex={1}
          minWidth={0}
          alignItems="center"
          gap={6}
          paddingLeft={2}
        >
          {/* Left group: Discard + Pause/Play */}
          <IconBtn
            icon="x"
            plain
            onPress={discardRecording}
            disabled={isDiscarding}
            title={t("recording.discard", { defaultValue: "Discard" })}
          />

          {isRecording ? (
            <IconBtn
              icon="pause"
              weight="fill"
              color={semanticColors.red}
              onPress={stopRecording}
              style={{ backgroundColor: c.tint.r.bg, borderColor: "transparent" }}
              title={t("recording.pause", { defaultValue: "Pause" })}
            />
          ) : (
            <IconBtn
              icon={isPlaying ? "pause" : "play"}
              weight="fill"
              color={c.accent}
              onPress={togglePlayback}
              style={{ backgroundColor: c.navActive, borderColor: "transparent" }}
              title={t("recording.play", { defaultValue: "Play" })}
            />
          )}

          {/* Waveform + Duration */}
          <XStack flex={1} alignItems="center" gap={10} minWidth={0}>
            {waveform}
            <T
              step="code13"
              color={isRecording ? semanticColors.red : c.accent}
              style={{ minWidth: 36, textAlign: "right", fontVariant: ["tabular-nums"] }}
            >
              {formatDuration(audioRecording?.duration || recordingDuration)}
            </T>
          </XStack>

          {/* Transcribe (optional) — the send lives outside the pill */}
          {onTranscribe && (
            <IconBtn
              icon="pencil-simple-line"
              plain
              onPress={handleTranscribe}
              disabled={isTranscribing}
              title={t("recording.transcribe", { defaultValue: "Transcribe to text" })}
            />
          )}
        </XStack>
      )
    }

    return (
      <>
        {plusButton}
        <RNView
          // As tall as the round controls at rest so one line reads centred;
          // taller than that, the field grows and the controls stay at the foot.
          style={{ flex: 1, minWidth: 0, minHeight: COMPOSE_CONTROL, justifyContent: "center" }}
          {...({ dataSet: { compose: "field" } } as object)}
        >
          <TextInput
            testID="composer-input"
            ref={inputRef}
            multiline
            numberOfLines={1}
            value={text}
            onChangeText={handleTextChange}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            editable={!disabled}
            placeholder={resolvedPlaceholder}
            placeholderTextColor={c.text3}
            autoComplete="off"
            autoCorrect={false}
            spellCheck={false}
            enterKeyHint="send"
            style={
              {
                // Height is written by fitField (DOM-owned) — never set it here.
                width: "100%",
                minHeight: TEXTAREA_MIN_HEIGHT,
                maxHeight: TEXTAREA_MAX_HEIGHT,
                paddingHorizontal: 6,
                paddingVertical: 0,
                margin: 0,
                borderWidth: 0,
                backgroundColor: "transparent",
                color: c.text,
                fontFamily: FONT_SANS,
                fontSize: 16,
                lineHeight: 24,
                fontWeight: "400",
                letterSpacing: 0,
                outlineStyle: "none",
                resize: "none",
                overflowX: "hidden",
                overflowY: "hidden",
              } as any
            }
          />
        </RNView>
        {micButton}
      </>
    )
  }

  const manageLabel = t("composer.manageApps", { defaultValue: "Manage" })
  const canUseLabel = t("composer.canUse", {
    defaultValue: "{{name}} can use",
    name: agentName ?? t("conversation.agent"),
  })
  // `.compose-meta`: the label + app chips scroll sideways in one row; the
  // Manage chip is pinned at the far right and never scrolls away.
  const metaLead = agentId ? (
    <>
      <T step="codenote" tone="text3" style={{ flexShrink: 0 }}>
        {canUseLabel}
      </T>
      {agentApps.map((app) => {
        const icon = appIconUrl(app)
        return (
          <ChipBtn
            key={app.appId}
            onPress={() => openWindow("app", { appId: app.appId, workspaceId }, false)}
            style={{ flexShrink: 0 }}
          >
            {icon ? (
              <img
                src={icon}
                alt=""
                width={13}
                height={13}
                style={{ width: 13, height: 13, borderRadius: 3, display: "block" }}
              />
            ) : (
              <Ph name="squares-four" size={13} color={c.text3} />
            )}
            <T step="12" tone="text2" numberOfLines={1}>
              {app.name}
            </T>
          </ChipBtn>
        )
      })}
    </>
  ) : null
  const manageChip = agentId ? (
    <ChipBtn
      icon="sliders-horizontal"
      onPress={() =>
        openWindow(
          "agent",
          { agentId: agentId.startsWith("agent_") ? agentId : `agent_${agentId}`, workspaceId },
          true,
        )
      }
      style={{ flexShrink: 0 }}
    >
      {manageLabel}
    </ChipBtn>
  ) : null

  const padX = pane.narrow ? 10 : pane.compact ? 14 : 28

  return (
    <YStack
      ref={containerRef}
      testID="composer-root"
      // data-channel-id: lets the browser smoke pick THIS chat's composer when
      // several chat windows are open (preview tabs pin on write, so a second
      // openChat lands in a fresh tab next to the pinned one).
      {...({ dataSet: { channelId } } as object)}
      // `.composer` — rides the sheet; no card, no gradient.
      paddingTop={pane.compact ? 8 : 12}
      paddingHorizontal={padX}
      paddingBottom={Math.max(pane.compact ? 14 : 22, bottomInset)}
      onPress={handleContainerPress}
      cursor={isRecordingOrPaused ? "default" : "text"}
      position="relative"
    >
      {/* `.composer-in` — 760px, centred */}
      <YStack width="100%" maxWidth={THREAD_MAX_WIDTH} alignSelf="center" position="relative">
        {errorBanner}

        {/* File attachment preview — a card above the pill. Dual layout:
          ≤5 files: full rows with icon + name + type label
          >5 files: wrapping thumbnail grid with capped height + scroll
          Also shown when there's only a validation error (all files rejected). */}
        {(hasFileAttachment || fileUpload.error) && (
          <YStack
            padding={12}
            marginBottom={10}
            borderRadius={16}
            backgroundColor={c.bgStep}
            // @ts-ignore web-only lift
            style={{ boxShadow: c.liftSm }}
          >
            {fileUpload.selectedFiles.length > 0 && (
              <YStack gap={8}>
                {/* Discreet header row: file count + clear-all text link */}
                <XStack alignItems="center" justifyContent="space-between" paddingHorizontal={2}>
                  <T step="codenote" tone="text3">
                    {fileUpload.selectedFiles.length}{" "}
                    {fileUpload.selectedFiles.length === 1 ? "file" : "files"}
                  </T>
                  <Pressable
                    onPress={fileUpload.isUploading ? undefined : fileUpload.clear}
                    disabled={fileUpload.isUploading}
                  >
                    <T
                      step="12"
                      tone="text3"
                      style={{
                        opacity: fileUpload.isUploading ? 0.4 : 0.8,
                        textDecorationLine: "underline",
                      }}
                    >
                      Clear all
                    </T>
                  </Pressable>
                </XStack>

                {fileUpload.selectedFiles.length <= 5 ? (
                  /* ── Layout 1: ≤5 files — full rows with icon + name + type ── */
                  <YStack gap={6}>
                    {fileUpload.selectedFiles.map((file, idx) => {
                      const previewUrl = fileUpload.previewUrls[idx]
                      const kind = getFileKind(file)
                      const cfg = FILE_KIND_CONFIG[kind]
                      const isImage = kind === "image"
                      return (
                        <XStack
                          key={`${file.name}-${idx}`}
                          testID="composer-attach-chip"
                          alignItems="center"
                          gap={10}
                          padding={8}
                          backgroundColor={c.nest}
                          borderRadius={12}
                        >
                          {/* Icon / thumbnail */}
                          <YStack
                            width={36}
                            height={36}
                            borderRadius={8}
                            overflow="hidden"
                            flexShrink={0}
                            alignItems="center"
                            justifyContent="center"
                            backgroundColor={isImage ? c.nest : cfg.bg}
                          >
                            {isImage && previewUrl ? (
                              <img
                                src={previewUrl}
                                alt={file.name}
                                style={{
                                  width: 36,
                                  height: 36,
                                  objectFit: "cover",
                                  display: "block",
                                  borderRadius: 8,
                                }}
                              />
                            ) : (
                              <Ph name={cfg.icon} size={20} color={cfg.color} />
                            )}
                          </YStack>

                          {/* Name + type */}
                          <YStack flex={1} minWidth={0} gap={1}>
                            <T step="sm" ellipsis>
                              {file.name}
                            </T>
                            <T step="codenote" color={cfg.color}>
                              {cfg.label}
                            </T>
                          </YStack>

                          {/* Remove button */}
                          <IconBtn
                            icon="x"
                            plain
                            sm
                            testID="composer-attach-remove"
                            onPress={() => fileUpload.removeFile(idx)}
                            disabled={fileUpload.isUploading}
                          />
                        </XStack>
                      )
                    })}
                  </YStack>
                ) : (
                  /* ── Layout 2: >5 files — wrapping thumbnail grid ── */
                  <XStack
                    flexWrap="wrap"
                    gap={8}
                    style={{
                      maxHeight: 230,
                      overflowY: "auto",
                      scrollbarWidth: "thin",
                      WebkitOverflowScrolling: "touch",
                    }}
                  >
                    {fileUpload.selectedFiles.map((file, idx) => {
                      const previewUrl = fileUpload.previewUrls[idx]
                      const kind = getFileKind(file)
                      const cfg = FILE_KIND_CONFIG[kind]
                      const isImage = kind === "image"
                      return (
                        <YStack
                          key={`${file.name}-${idx}`}
                          testID="composer-attach-chip"
                          width={64}
                          flexShrink={0}
                          gap={3}
                        >
                          <YStack
                            width={64}
                            height={64}
                            borderRadius={10}
                            overflow="hidden"
                            backgroundColor={isImage ? c.nest : cfg.bg}
                            position="relative"
                            alignItems="center"
                            justifyContent="center"
                          >
                            {isImage && previewUrl ? (
                              <img
                                src={previewUrl}
                                alt={file.name}
                                style={{
                                  width: 64,
                                  height: 64,
                                  objectFit: "cover",
                                  display: "block",
                                }}
                              />
                            ) : (
                              <Ph name={cfg.icon} size={26} color={cfg.color} />
                            )}

                            {/* Extension badge — bottom-left corner, helps identify file type when name is truncated */}
                            {!isImage && cfg.ext && (
                              <View
                                position="absolute"
                                bottom={3}
                                left={3}
                                zIndex={1}
                                paddingLeft={4}
                                paddingRight={4}
                                style={{
                                  height: 14,
                                  borderRadius: 4,
                                  backgroundColor: c.inkPill,
                                  alignItems: "center",
                                  justifyContent: "center",
                                  display: "flex",
                                }}
                              >
                                <T
                                  step="codenote"
                                  color={c.inkPillText}
                                  style={{ fontSize: 8, lineHeight: 9 }}
                                >
                                  {cfg.ext}
                                </T>
                              </View>
                            )}

                            {/* Remove button — overlaid in top-right corner */}
                            <YStack position="absolute" top={3} right={3} zIndex={1}>
                              <Pressable
                                testID="composer-attach-remove"
                                onPress={() => fileUpload.removeFile(idx)}
                                disabled={fileUpload.isUploading}
                                style={{
                                  width: 18,
                                  height: 18,
                                  borderRadius: 9,
                                  backgroundColor: c.inkPill,
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Ph name="x" size={10} color={c.inkPillText} />
                              </Pressable>
                            </YStack>

                            {/* Upload progress overlay */}
                            {fileUpload.isUploading && (
                              <YStack
                                position="absolute"
                                bottom={0}
                                left={0}
                                right={0}
                                height={3}
                                backgroundColor={c.wash2}
                              >
                                <YStack
                                  height="100%"
                                  width={`${fileUpload.progress}%`}
                                  backgroundColor={c.accent}
                                />
                              </YStack>
                            )}
                          </YStack>

                          {/* Truncated file name */}
                          <T
                            step="codenote"
                            tone="text3"
                            center
                            ellipsis
                            style={{ width: 64, fontSize: 9 }}
                          >
                            {file.name}
                          </T>
                        </YStack>
                      )
                    })}
                  </XStack>
                )}
              </YStack>
            )}
            {fileUpload.error && (
              <T step="12" color={c.tint.r.tx} style={{ padding: 6 }}>
                {fileUpload.error}
              </T>
            )}
          </YStack>
        )}

        {/* Mention chips row — rendered inline above the pill when skills are selected (`.attach-row`) */}
        {mention.chips.length > 0 && (
          <XStack paddingLeft={12} paddingBottom={10} gap={8} flexWrap="wrap">
            {mention.chips.map((chip) => (
              <MentionChip key={chip.id} chip={chip} onRemove={mention.onRemoveChip} />
            ))}
          </XStack>
        )}

        {/* Mention dropdown — positioned above the input via absolute positioning */}
        {mention.isOpen && (
          <MentionDropdown
            groups={mention.groups}
            selectedIndex={mention.selectedIndex}
            onSelect={handleSelectMention}
            onClose={mention.closeDropdown}
            isLoading={mention.isFetchingResources}
          />
        )}

        {/* `.compose` — the pill + send. Controls sit at the BOTTOM so the
            field grows upward over them; the radius is fixed at half the
            one-line height (a true pill at rest, straight sides once grown). */}
        <XStack alignItems="flex-end">
          <XStack
            testID="composer-pill"
            flex={1}
            minWidth={0}
            alignItems="flex-end"
            gap={8}
            paddingTop={4}
            paddingBottom={4}
            paddingLeft={4}
            paddingRight={8}
            borderRadius={COMPOSE_PILL_RADIUS}
            backgroundColor={c.bgHeader}
            borderWidth={1}
            borderColor={
              isFocused && !isRecordingOrPaused ? "rgba(111,39,255,0.30)" : "transparent"
            }
            // @ts-ignore web-only focus ring
            style={{
              boxShadow:
                isFocused && !isRecordingOrPaused
                  ? "0 0 0 3px rgba(111,39,255,0.07), 0 10px 30px -18px rgba(111,39,255,0.4)"
                  : "none",
              transition: "border-color 0.25s, box-shadow 0.25s",
            }}
          >
            {renderPillContent()}
          </XStack>
          {stopButton}
          {sendButton}
        </XStack>

        {/* `.compose-meta` — "{agent} can use" + app chips (scroll) + Manage (pinned right).
            In conversations with ≥1 message the row is REPLACED by the
            contextual suggested-prompt chips (backend-generated after each
            agent turn; tap → text lands in the composer, editable, no send).
            No suggestions yet (or generation failed) → nothing renders. */}
        {(hasMessages ? suggestions.length > 0 : metaLead != null) && (
          <XStack
            alignItems="center"
            gap={8}
            marginTop={pane.compact ? 8 : 10}
            // Tools row keeps its historical inset; the suggestion chips align
            // flush with the pill's left edge (no extra margin, Pablo 2026-10-29).
            paddingLeft={hasMessages ? 0 : pane.compact ? 0 : 12}
            overflow="hidden"
          >
            {/* Clip box: whatever the chips do while scrolling (overscroll,
                momentum) stays inside this row and never paints over the
                composer's edge or shadow. */}
            <View style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flex: 1, minWidth: 0 }}
                contentContainerStyle={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingRight: 12,
                }}
                {...({ dataSet: { compose: "meta" } } as object)}
              >
                {hasMessages
                  ? suggestions.map((prompt) => (
                      <ChipBtn
                        key={prompt}
                        testID="composer-suggested-prompt"
                        onPress={() => insertSuggestedPrompt(prompt)}
                        style={{ flexShrink: 0 }}
                      >
                        {prompt}
                      </ChipBtn>
                    ))
                  : metaLead}
              </ScrollView>
            </View>
            {!hasMessages && manageChip}
          </XStack>
        )}
      </YStack>

      {/* Overlay de drag-and-drop: se muestra al arrastrar archivos externos
          sobre el composer. pointerEvents="none" para no robar el 'drop' al
          contenedor (los listeners viven en el YStack padre). */}
      {isDraggingFiles && (
        <YStack
          testID="composer-drop-overlay"
          position="absolute"
          top={4}
          left={padX - 8}
          right={padX - 8}
          bottom={8}
          zIndex={10}
          pointerEvents="none"
          alignItems="center"
          justifyContent="center"
          gap={8}
          borderRadius={24}
          borderWidth={2}
          borderStyle="dashed"
          borderColor={c.borderAccent}
          backgroundColor={c.navActive}
          animation="quick"
          enterStyle={{ opacity: 0 }}
        >
          <Ph name="upload-simple" size={26} color={c.accent} />
          <T step="sm" tone="accent">
            {t("conversation.dropFilesHere")}
          </T>
        </YStack>
      )}
    </YStack>
  )
}
