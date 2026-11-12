/**
 * Recording Session Store — module-level singleton for the audio recording engine.
 *
 * WHY: Fast Refresh (Expo dev server) remounts React components without unloading
 * the page. All recording state held in component refs/state dies silently.
 * This singleton lives OUTSIDE the React tree — it survives remounts, so the
 * MediaRecorder keeps capturing audio and the UI can re-hydrate on next mount.
 *
 * Architecture:
 * - `recordingEngine` — plain module-level object holding non-serializable resources
 *   (MediaRecorder/RecordRTC, MediaStream, AudioContext, chunks). NOT reactive.
 * - `useRecordingSessionStore` — zustand store for the reactive UI state that
 *   components subscribe to (recordingState, duration, channelId, error).
 *
 * The InputComposer delegates start/stop/discard to this module and subscribes
 * to the zustand store for rendering. On mount, if the engine has an active
 * recording, the composer re-hydrates its UI from the store.
 */

import type RecordRTC from 'recordrtc'
import { create } from 'zustand'

// ── Types ────────────────────────────────────────────────────────────────────

export type RecordingSessionState = 'idle' | 'recording' | 'paused'

export interface RecordingSessionError {
  type: 'permission_denied' | 'not_found' | 'not_supported' | 'interrupted' | 'unknown'
  details?: string
}

/** Non-serializable engine resources — kept outside zustand. */
interface RecordingEngine {
  recorder: MediaRecorder | RecordRTC | null
  chunks: Blob[]
  stream: MediaStream | null
  audioContext: AudioContext | null
  analyserNode: AnalyserNode | null
  timerInterval: ReturnType<typeof setInterval> | null
  /** Seconds recorded so far — updated by the timer, read on stop. */
  durationSeconds: number
  /** Metering samples collected during recording (for waveform). */
  samples: number[]
  /** The blob produced by stopRecording — set when transitioning to paused. */
  pausedBlob: Blob | null
  pausedUrl: string | null
}

// ── Module-level engine singleton (NOT reactive — survives Fast Refresh) ────

const engine: RecordingEngine = {
  recorder: null,
  chunks: [],
  stream: null,
  audioContext: null,
  analyserNode: null,
  timerInterval: null,
  durationSeconds: 0,
  samples: [],
  pausedBlob: null,
  pausedUrl: null,
}

/** Get direct access to the engine (for the composer's recording operations). */
export function getRecordingEngine(): RecordingEngine {
  return engine
}

// ── Zustand store for reactive UI state ─────────────────────────────────────

interface RecordingSessionStoreState {
  /** Current recording state — mirrors what the composer used to hold locally. */
  recordingState: RecordingSessionState
  /** Channel that owns this recording session. */
  channelId: string | null
  /** Duration in seconds (updated by the engine timer). */
  duration: number
  /** Error from the last recording attempt. */
  error: RecordingSessionError | null
  /** Whether the engine has live resources (recorder, stream, etc.). */
  engineActive: boolean

  // Actions — called by the composer's recording methods
  setRecordingState: (state: RecordingSessionState) => void
  setChannelId: (id: string | null) => void
  setDuration: (seconds: number) => void
  setError: (error: RecordingSessionError | null) => void
  setEngineActive: (active: boolean) => void
  /** Reset everything — called on discard or after successful send. */
  reset: () => void
}

export const useRecordingSessionStore = create<RecordingSessionStoreState>()((set) => ({
  recordingState: 'idle',
  channelId: null,
  duration: 0,
  error: null,
  engineActive: false,

  setRecordingState: (recordingState) => set({ recordingState }),
  setChannelId: (channelId) => set({ channelId }),
  setDuration: (duration) => set({ duration }),
  setError: (error) => set({ error }),
  setEngineActive: (engineActive) => set({ engineActive }),
  reset: () =>
    set({
      recordingState: 'idle',
      channelId: null,
      duration: 0,
      error: null,
      engineActive: false,
    }),
}))

// ── Engine lifecycle helpers ─────────────────────────────────────────────────

/** Start the engine timer — ticks duration every second. */
export function startEngineTimer(): void {
  stopEngineTimer()
  engine.timerInterval = setInterval(() => {
    engine.durationSeconds += 1
    useRecordingSessionStore.getState().setDuration(engine.durationSeconds)
  }, 1000)
}

/** Stop the engine timer. */
export function stopEngineTimer(): void {
  if (engine.timerInterval) {
    clearInterval(engine.timerInterval)
    engine.timerInterval = null
  }
}

/** Clean up all engine resources (stream tracks, audio context, recorder). */
export function cleanupEngine(): void {
  stopEngineTimer()

  if (engine.recorder) {
    if (engine.recorder instanceof MediaRecorder) {
      if (engine.recorder.state !== 'inactive') {
        try { engine.recorder.stop() } catch { /* already stopped */ }
      }
    } else {
      // RecordRTC
      try { (engine.recorder as RecordRTC).stopRecording(() => {}) } catch { /* noop */ }
    }
    engine.recorder = null
  }

  engine.chunks = []

  if (engine.stream) {
    engine.stream.getTracks().forEach((track) => track.stop())
    engine.stream = null
  }

  if (engine.audioContext) {
    try { engine.audioContext.close() } catch { /* already closed */ }
    engine.audioContext = null
  }

  engine.analyserNode = null
  engine.durationSeconds = 0
  engine.samples = []

  if (engine.pausedUrl) {
    URL.revokeObjectURL(engine.pausedUrl)
    engine.pausedUrl = null
  }
  engine.pausedBlob = null
}

/** Full teardown: cleanup engine + reset store. */
export function destroyRecordingSession(): void {
  cleanupEngine()
  useRecordingSessionStore.getState().reset()
}

/** Check if there's an active recording that would be lost on navigation. */
export function hasActiveRecording(): boolean {
  const state = useRecordingSessionStore.getState()
  return state.recordingState === 'recording' || state.engineActive
}

/** Check if there's any audio at risk (recording, paused with blob, or sending). */
export function hasAudioAtRisk(isSending: boolean): boolean {
  const state = useRecordingSessionStore.getState()
  return state.recordingState !== 'idle' || isSending
}
