import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  useRecordingSessionStore,
  getRecordingEngine,
  startEngineTimer,
  stopEngineTimer,
  cleanupEngine,
  destroyRecordingSession,
  hasActiveRecording,
  hasAudioAtRisk,
} from '../recordingSessionStore'

/**
 * Recording Session Store — the module-level singleton that survives Fast Refresh.
 *
 * Key invariant: the engine (MediaRecorder, stream, chunks) lives OUTSIDE the
 * React tree. When Fast Refresh remounts components, the zustand store and the
 * engine singleton persist — the composer re-hydrates from them on mount.
 */

describe('recordingSessionStore — state management', () => {
  beforeEach(() => {
    destroyRecordingSession()
  })

  it('starts idle with no channel', () => {
    const state = useRecordingSessionStore.getState()
    expect(state.recordingState).toBe('idle')
    expect(state.channelId).toBeNull()
    expect(state.duration).toBe(0)
    expect(state.error).toBeNull()
    expect(state.engineActive).toBe(false)
  })

  it('transitions to recording with channelId', () => {
    const store = useRecordingSessionStore.getState()
    store.setRecordingState('recording')
    store.setChannelId('ch_test_123')
    store.setEngineActive(true)

    const state = useRecordingSessionStore.getState()
    expect(state.recordingState).toBe('recording')
    expect(state.channelId).toBe('ch_test_123')
    expect(state.engineActive).toBe(true)
  })

  it('resets all state on reset()', () => {
    const store = useRecordingSessionStore.getState()
    store.setRecordingState('recording')
    store.setChannelId('ch_test_123')
    store.setDuration(42)
    store.setEngineActive(true)

    store.reset()

    const state = useRecordingSessionStore.getState()
    expect(state.recordingState).toBe('idle')
    expect(state.channelId).toBeNull()
    expect(state.duration).toBe(0)
    expect(state.engineActive).toBe(false)
  })
})

describe('recordingSessionStore — Fast Refresh survival', () => {
  beforeEach(() => {
    destroyRecordingSession()
  })

  it('engine and store survive a simulated remount (state persists)', () => {
    // Simulate: user starts recording
    const store = useRecordingSessionStore.getState()
    store.setRecordingState('recording')
    store.setChannelId('ch_test_456')
    store.setEngineActive(true)

    // Simulate engine state (what the composer would set)
    const engine = getRecordingEngine()
    engine.durationSeconds = 15
    engine.chunks = [new Blob(['chunk1']), new Blob(['chunk2'])]

    // === SIMULATED FAST REFRESH: component remounts ===
    // The component's local state is destroyed, but the module-level store
    // and engine singleton persist. A new mount reads from them.

    const stateAfterRemount = useRecordingSessionStore.getState()
    expect(stateAfterRemount.recordingState).toBe('recording')
    expect(stateAfterRemount.channelId).toBe('ch_test_456')
    expect(stateAfterRemount.engineActive).toBe(true)

    const engineAfterRemount = getRecordingEngine()
    expect(engineAfterRemount.durationSeconds).toBe(15)
    expect(engineAfterRemount.chunks).toHaveLength(2)
  })

  it('destroyRecordingSession cleans both engine and store', () => {
    const store = useRecordingSessionStore.getState()
    store.setRecordingState('recording')
    store.setChannelId('ch_test_789')
    store.setEngineActive(true)

    const engine = getRecordingEngine()
    engine.durationSeconds = 30
    engine.chunks = [new Blob(['data'])]

    destroyRecordingSession()

    const state = useRecordingSessionStore.getState()
    expect(state.recordingState).toBe('idle')
    expect(state.channelId).toBeNull()
    expect(state.engineActive).toBe(false)

    expect(engine.durationSeconds).toBe(0)
    expect(engine.chunks).toHaveLength(0)
    expect(engine.recorder).toBeNull()
    expect(engine.stream).toBeNull()
  })
})

describe('recordingSessionStore — engine timer', () => {
  beforeEach(() => {
    destroyRecordingSession()
  })

  it('timer updates duration in the store', async () => {
    vi.useFakeTimers()

    startEngineTimer()

    // Advance 3 seconds
    await vi.advanceTimersByTimeAsync(3000)

    expect(useRecordingSessionStore.getState().duration).toBe(3)
    expect(getRecordingEngine().durationSeconds).toBe(3)

    stopEngineTimer()
    vi.useRealTimers()
  })

  it('stopEngineTimer halts updates', async () => {
    vi.useFakeTimers()

    startEngineTimer()
    await vi.advanceTimersByTimeAsync(2000)
    stopEngineTimer()

    const durationAfterStop = useRecordingSessionStore.getState().duration
    await vi.advanceTimersByTimeAsync(2000)

    expect(useRecordingSessionStore.getState().duration).toBe(durationAfterStop)
    vi.useRealTimers()
  })
})

describe('hasActiveRecording / hasAudioAtRisk', () => {
  beforeEach(() => {
    destroyRecordingSession()
  })

  it('hasActiveRecording is false when idle', () => {
    expect(hasActiveRecording()).toBe(false)
  })

  it('hasActiveRecording is true when recording', () => {
    useRecordingSessionStore.getState().setRecordingState('recording')
    expect(hasActiveRecording()).toBe(true)
  })

  it('hasActiveRecording is true when engine is active (even if state is stale)', () => {
    useRecordingSessionStore.getState().setEngineActive(true)
    expect(hasActiveRecording()).toBe(true)
  })

  it('hasAudioAtRisk covers recording + paused + sending', () => {
    expect(hasAudioAtRisk(false)).toBe(false)

    useRecordingSessionStore.getState().setRecordingState('recording')
    expect(hasAudioAtRisk(false)).toBe(true)

    useRecordingSessionStore.getState().setRecordingState('paused')
    expect(hasAudioAtRisk(false)).toBe(true)

    useRecordingSessionStore.getState().setRecordingState('idle')
    expect(hasAudioAtRisk(true)).toBe(true) // isSending
    expect(hasAudioAtRisk(false)).toBe(false)
  })
})
