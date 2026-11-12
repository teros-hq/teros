/**
 * useMediaSession tests (F5i) — the AirPods/media-key → mic-mute door.
 *
 * Strategy (the established repo patterns):
 *
 * A) BEHAVIORAL (renderHook + a mocked navigator.mediaSession, the
 *    useEarcons.render.test.ts pattern): the claim registers play/pause
 *    handlers → both fire the caller's toggle; the keep-alive <audio> starts
 *    with the session and dies with it; the release clears metadata,
 *    playbackState and handlers.
 *
 *    F5i-c (2026-10-05, live bug found by Pablo): the keep-alive's FIRST
 *    play() runs in the effect — OUTSIDE the user-gesture call stack — and
 *    Safari iOS rejects it; the old code swallowed the rejection, so the
 *    audio never sounded and the media buttons never routed (stem press →
 *    iOS "unhandled action" triple beep; the lock-screen card still showed
 *    because it is only metadata). The audio mock is now an autoplay-policy
 *    stand-in: `playRejections` queues rejections handed back one per
 *    play() call (Safari iOS outside a gesture); an empty queue = allowed
 *    (desktop/Chrome). Cases pinned:
 *      - the rejection is LOGGED (console.warn), never swallowed;
 *      - any tap (pointerdown) retries the play — the gesture-unlock;
 *      - the tap listener drops itself once the audio sounds;
 *      - visibilitychange → visible retries a paused keep-alive (the F5g
 *        pattern — Safari suspending the audio in background);
 *      - the release drops both listeners — no zombies after hang-up.
 *
 *    F5i-c probe (live evidence 19:15): with getUserMedia live iOS routes
 *    the stem press to MIC-CONTROL (the Dynamic Island toast "No se puede
 *    controlar el micrófono con los AirPods 4 (ANC)" is iOS, not web). The
 *    hook probes the `togglemicrophone` media-session action: supported →
 *    the intent fires our toggleMute at the page (the cleanest door);
 *    unsupported → the register throws → logged fallback, play/pause keep
 *    the door. Both paths pinned.
 *
 * B) WIRING (source-level, the voiceMicGateWiring.render.test.ts
 *    lint-as-test pattern): VoiceSessionContext wires the hook ONLY for the
 *    native engine + a live session, passing the existing toggleMute and the
 *    agent's display name.
 *
 * C) ASSET (F5i-b): the keep-alive WAV itself must be near-silent, NOT
 *    silent — PCM 16-bit mono 8kHz with every sample = 1 (the LSB). An
 *    all-zero WAV was the F5i-b bug: volume-0/muted playback of true silence
 *    is "inaudible" to Safari/Chrome → no media-button action routing
 *    (AirPods stem → iOS triple beep).
 *
 * D) SOURCE PINS (F5i-c): the silent swallow (.catch(() => {})) must never
 *    come back; the visible rejection log and both retry listeners stay in
 *    the source.
 *
 *   cd packages/app && npx vitest run src/hooks/voice/useMediaSession.render.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMediaSession } from './useMediaSession'

const here = dirname(fileURLToPath(import.meta.url))

/** A recording stand-in for navigator.mediaSession. */
function makeMediaSession() {
  const handlers = new Map<string, (() => void) | null>()
  return {
    handlers,
    metadata: null as unknown,
    playbackState: 'none' as 'none' | 'paused' | 'playing',
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      if (handler === null) handlers.delete(action)
      else handlers.set(action, handler)
    }),
  }
}

/**
 * A media session WITHOUT the togglemicrophone action (the Safari fallback):
 * registering it throws, exactly like an implementation that does not know
 * the action. Play/pause keep working — the probe must degrade, never break.
 */
function makeMediaSessionWithoutToggleMicrophone() {
  const ms = makeMediaSession()
  const orig = ms.setActionHandler.getMockImplementation()!
  ms.setActionHandler.mockImplementation((action: string, handler: (() => void) | null) => {
    if (action === 'togglemicrophone' && handler !== null) {
      throw new TypeError(`unknown media session action '${action}'`)
    }
    return orig(action, handler)
  })
  return ms
}

/** Fire the OS media event exactly like the browser would. */
function press(ms: ReturnType<typeof makeMediaSession>, action: 'play' | 'pause') {
  const handler = ms.handlers.get(action)
  if (!handler) throw new Error(`no handler registered for ${action}`)
  handler()
}

/** Let the play() promise chains (.then/.catch) run before asserting. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Override document.visibilityState for a visibilitychange test turn. */
function setVisibilityState(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

describe('useMediaSession — behavioral (the claim/keep-alive/release contract)', () => {
  let ms: ReturnType<typeof makeMediaSession>
  type MockAudio = {
    src: string
    loop: boolean
    volume: number
    paused: boolean
    play: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    removeAttribute: ReturnType<typeof vi.fn>
    load: ReturnType<typeof vi.fn>
  }
  let createdAudios: MockAudio[]

  // The autoplay-policy stand-in (F5i-c): queued rejections are handed to
  // play() one per call — Safari iOS rejecting a play() outside a user
  // gesture. An empty queue = play allowed (the desktop/Chrome path).
  let playRejections: Array<{ name?: string; message?: string }> = []

  /** A scriptable <audio>: play() honors the rejection queue; paused flips per the HTML play algorithm. */
  function makeMockAudio(): MockAudio {
    const audio: MockAudio = {
      src: '',
      loop: false,
      volume: 1,
      paused: true,
      play: vi.fn((): Promise<void> => {
        if (playRejections.length > 0) return Promise.reject(playRejections.shift())
        // Allowed — the HTML play algorithm flips paused synchronously; the
        // promise is about reaching "playing", not about paused.
        audio.paused = false
        return Promise.resolve()
      }),
      pause: vi.fn(() => {
        audio.paused = true
      }),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    }
    return audio
  }

  beforeEach(() => {
    ms = makeMediaSession()
    createdAudios = []
    playRejections = []
    vi.stubGlobal('navigator', { mediaSession: ms })
    vi.stubGlobal('MediaMetadata', class MediaMetadata {
      title: string
      artist: string
      album: string
      constructor(init: { title?: string; artist?: string; album?: string }) {
        this.title = init.title ?? ''
        this.artist = init.artist ?? ''
        this.album = init.album ?? ''
      }
    })
    // jsdom has document.createElement('audio') but not .play/.pause on it —
    // intercept element creation so the keep-alive is fully observable.
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'audio') {
        const audio = makeMockAudio()
        createdAudios.push(audio)
        return audio as unknown as HTMLAudioElement
      }
      return el
    }) as typeof document.createElement)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Drop any per-test visibilityState override (restores the jsdom default).
    delete (document as unknown as { visibilityState?: string }).visibilityState
  })

  it('claims the now-playing session while active: metadata + playing + handlers', () => {
    const toggle = vi.fn()
    renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: toggle }),
    )

    expect(ms.metadata).not.toBeNull()
    expect((ms.metadata as { title: string }).title).toBe('Alice — sesión de voz')
    expect((ms.metadata as { artist: string }).artist).toBe('Teros')
    expect(ms.playbackState).toBe('playing')
    expect(ms.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function))
    expect(ms.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function))
  })

  it('both play AND pause fire the SAME toggle (toggle semantics — whatever the OS sends)', () => {
    const toggle = vi.fn()
    renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: toggle }),
    )

    // The OS sends 'pause' (playbackState stays 'playing)…
    press(ms, 'pause')
    expect(toggle).toHaveBeenCalledTimes(1)
    // …or 'play' (some implementations flip state) — same door either way.
    press(ms, 'play')
    expect(toggle).toHaveBeenCalledTimes(2)
  })

  it('the handler always calls the LATEST toggle (ref indirection, no stale closure)', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ onToggleMute }: { onToggleMute: () => void }) =>
        useMediaSession({ active: true, agentName: 'Alice', onToggleMute }),
      { initialProps: { onToggleMute: first } },
    )
    rerender({ onToggleMute: second })

    press(ms, 'pause')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  // ─── F5i-c: the togglemicrophone probe (live evidence 19:15) ──────────────

  it('probes the togglemicrophone action — a supported Safari fires the toggle on it (F5i-c)', () => {
    const toggle = vi.fn()
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: toggle }))

    // Registered → the iOS mic-control intent (the stem press iOS routes to
    // call-control) arrives AT the page as our toggleMute — the cleanest door.
    expect(ms.setActionHandler).toHaveBeenCalledWith('togglemicrophone', expect.any(Function))
    const handler = ms.handlers.get('togglemicrophone')
    expect(handler).toBeTypeOf('function')
    handler?.()
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when togglemicrophone is NOT supported — play/pause keep the door (F5i-c)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const toggle = vi.fn()
    // The Safari fallback: registering the unknown action throws.
    ms = makeMediaSessionWithoutToggleMicrophone()
    vi.stubGlobal('navigator', { mediaSession: ms })
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: toggle }))

    // The probe failed LOUDLY (logged, not swallowed)…
    expect(warnSpy).toHaveBeenCalledWith(
      '[useMediaSession] togglemicrophone action not supported — iOS keeps call-control routing; the stem may stay intercepted:',
      'TypeError',
      expect.any(String),
    )
    // …and nothing broke: the claim stands, play/pause still fire the toggle.
    expect(ms.metadata).not.toBeNull()
    expect(ms.playbackState).toBe('playing')
    press(ms, 'pause')
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('releases the togglemicrophone handler too when it was captured (no zombie probe)', () => {
    const { unmount } = renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }),
    )
    expect(ms.handlers.has('togglemicrophone')).toBe(true)
    unmount()
    expect(ms.handlers.has('togglemicrophone')).toBe(false)
    expect(ms.handlers.size).toBe(0)
  })

  it('the unsupported-action release path never re-throws (hostile implementation, capture stays dead)', () => {
    // Register while supported, release while hostile — release() must not
    // call setActionHandler('togglemicrophone', null) on an implementation
    // that throws for the action, or the whole release would die mid-way.
    const toggle = vi.fn()
    const { unmount } = renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: toggle }),
    )
    // Flip hostile AFTER capture: now even null-ing the action throws.
    const orig = ms.setActionHandler.getMockImplementation()!
    ms.setActionHandler.mockImplementation((action: string, handler: (() => void) | null) => {
      if (action === 'togglemicrophone') throw new TypeError('gone')
      return orig(action, handler)
    })
    expect(() => unmount()).not.toThrow()
    // The universal doors still got released before the hostile action died.
    expect(ms.handlers.has('play')).toBe(false)
    expect(ms.handlers.has('pause')).toBe(false)
    expect(ms.metadata).toBeNull()
  })

  it('starts the near-silent keep-alive <audio> with the session (loop, volume 1 — F5i-b)', () => {
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))

    expect(createdAudios.length).toBe(1)
    const audio = createdAudios[0]
    expect(audio.src).toBe('/near-silence.wav')
    expect(audio.loop).toBe(true)
    // F5i-b: volume 1.0, NOT 0 — volume-0/muted audio is "inaudible" to
    // Safari/Chrome, which then refuse to route media-button actions to us
    // (the AirPods stem press → iOS "unhandled action" triple beep). The
    // near-inaudibility lives in the WAV (every sample = 1), not here.
    expect(audio.volume).toBe(1)
    expect(audio.play).toHaveBeenCalledTimes(1)
  })

  it('releases everything on unmount: keep-alive dead, metadata null, handlers off', () => {
    const { unmount } = renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }),
    )
    unmount()

    // Keep-alive: paused, src dropped, buffer dropped — no zombie audio.
    expect(createdAudios[0].pause).toHaveBeenCalledTimes(1)
    expect(createdAudios[0].removeAttribute).toHaveBeenCalledWith('src')
    expect(createdAudios[0].load).toHaveBeenCalled()
    // The claim: metadata cleared, state none, handlers null.
    expect(ms.metadata).toBeNull()
    expect(ms.playbackState).toBe('none')
    expect(ms.setActionHandler).toHaveBeenCalledWith('play', null)
    expect(ms.setActionHandler).toHaveBeenCalledWith('pause', null)
    expect(ms.handlers.size).toBe(0)
  })

  it('releases the claim when active goes false (session stop, hook stays mounted)', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useMediaSession({ active, agentName: 'Alice', onToggleMute: vi.fn() }),
      { initialProps: { active: true } },
    )
    rerender({ active: false })

    expect(ms.metadata).toBeNull()
    expect(ms.playbackState).toBe('none')
    expect(ms.handlers.size).toBe(0)
    // The keep-alive from the active stretch died with it.
    expect(createdAudios[0].pause).toHaveBeenCalledTimes(1)
  })

  it('does NOT map nexttrack/previoustrack (double/triple stem press — open question)', () => {
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))
    // togglemicrophone IS mapped (the F5i-c probe, above) — the deliberately
    // unmapped ones remain next/prev track.
    expect(ms.setActionHandler).not.toHaveBeenCalledWith('nexttrack', expect.anything())
    expect(ms.setActionHandler).not.toHaveBeenCalledWith('previoustrack', expect.anything())
  })

  it('never throws without navigator.mediaSession (old browsers/native)', () => {
    vi.stubGlobal('navigator', {})
    expect(() =>
      renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() })),
    ).not.toThrow()
  })

  // ─── F5i-c: the gesture-unlock ─────────────────────────────────────────────

  it('LOGS the initial play rejection instead of swallowing it (F5i-c)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Safari iOS: the first play() runs in the effect, outside the gesture →
    // NotAllowedError. The old code swallowed this — the exact bug.
    playRejections = [{ name: 'NotAllowedError', message: 'play() can only be initiated by a user gesture' }]
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))
    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledWith(
      '[useMediaSession] keep-alive play rejected (will retry on next tap):',
      'NotAllowedError',
      'play() can only be initiated by a user gesture',
    )
  })

  it('retries the play on ANY tap after the rejection — and drops the tap listener on success (F5i-c)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    playRejections = [{ name: 'NotAllowedError', message: 'gesture required' }]
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))
    await flushMicrotasks()

    // Rejected → still paused → the gesture-unlock is armed.
    expect(createdAudios[0].paused).toBe(true)
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))

    // The tap — any pointerdown anywhere on the page (orb, popover, anything).
    document.dispatchEvent(new Event('pointerdown'))
    expect(createdAudios[0].play).toHaveBeenCalledTimes(2) // retried INSIDE the gesture
    await flushMicrotasks()

    // Success → the tap-unlock dropped itself: further taps never touch play.
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    document.dispatchEvent(new Event('pointerdown'))
    expect(createdAudios[0].play).toHaveBeenCalledTimes(2)
  })

  it('never arms the tap-unlock when the first play succeeds (desktop/Chrome path)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))

    expect(createdAudios[0].play).toHaveBeenCalledTimes(1)
    expect(createdAudios[0].paused).toBe(false)
    expect(addSpy).not.toHaveBeenCalledWith('pointerdown', expect.any(Function))
    // A tap on a healthy session changes nothing.
    document.dispatchEvent(new Event('pointerdown'))
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1)
  })

  it('retries the play on visibilitychange → visible when Safari suspended it in background (F5g pattern)', async () => {
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))
    await flushMicrotasks()
    expect(createdAudios[0].paused).toBe(false) // healthy start

    createdAudios[0].paused = true // Safari suspended the audio while backgrounded
    setVisibilityState('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(createdAudios[0].play).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry while sounding or while hidden — the retry is for a paused keep-alive', async () => {
    renderHook(() => useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }))
    await flushMicrotasks()

    setVisibilityState('visible')
    document.dispatchEvent(new Event('visibilitychange')) // sounding — no-op
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1)

    createdAudios[0].paused = true
    setVisibilityState('hidden')
    document.dispatchEvent(new Event('visibilitychange')) // hidden — no-op
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1)
  })

  it('cleanup drops the unlock/retry listeners — no zombies after hang-up (F5i-c)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    playRejections = [{ name: 'NotAllowedError', message: 'gesture required' }]
    const { unmount } = renderHook(() =>
      useMediaSession({ active: true, agentName: 'Alice', onToggleMute: vi.fn() }),
    )
    await flushMicrotasks()
    unmount()

    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    // Behavioral: after hang-up, taps and tab switches never reach the dead element.
    document.dispatchEvent(new Event('pointerdown'))
    setVisibilityState('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1) // only the rejected initial
  })
})

// ─── B) VoiceSessionContext wiring — source-level ──────────────────────────

const CONTEXT_SRC = readFileSync(
  resolve(here, '../../contexts/VoiceSessionContext.tsx'),
  'utf8',
)

describe('VoiceSessionContext media-session wiring (F5i)', () => {
  it('wires the hook only for the native engine + a live session', () => {
    // The gate: nativeEngineEnabled AND an active agent — legacy engine or no
    // session never claims the OS media buttons (zero regression).
    expect(CONTEXT_SRC).toContain('active: nativeEngineEnabled && activeAgentId !== null')
  })

  it('passes the existing toggleMute as the door (no second mute path)', () => {
    // The SAME toggleMute the orb uses — the worklet receives the same
    // `mute` message whether the press came from the screen or the stem.
    expect(CONTEXT_SRC).toContain('onToggleMute: toggleMute')
  })

  it('resolves the agent display name for the metadata title (fallback Teros)', () => {
    expect(CONTEXT_SRC).toContain("a.agentId === activeAgentId)?.name ?? 'Teros'")
  })

  it('releases with the session — the hook lives inside the provider, not the orb', () => {
    // The hook is called at the PROVIDER level (unconditional call, gated by
    // its own `active` arg): the claim follows the session lifecycle, not the
    // ChatView mount — it survives tab switches exactly like the WS does.
    expect(CONTEXT_SRC).toMatch(/useMediaSession\(\{\s*active:/)
  })
})

// ─── C) The keep-alive asset itself — near-silence.wav (F5i-b) ──────────────
// The bug was IN the asset: a true-silence WAV (all-zero samples) at volume 0
// is "inaudible" to Safari/Chrome → no media-button action routing. The fix
// asset must be PCM 16-bit mono 8kHz with NON-zero samples (every sample = 1,
// the LSB) — this test pins that so a regeneration can never regress to
// all-zeros.

const WAV_PATH = resolve(here, '../../../public/near-silence.wav')

describe('near-silence.wav — the keep-alive asset (F5i-b)', () => {
  const buf = readFileSync(WAV_PATH)

  it('is a PCM 16-bit mono 8kHz WAV (the format the element expects)', () => {
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ')
    expect(buf.toString('ascii', 36, 40)).toBe('data')
    expect(buf.readUInt16LE(20)).toBe(1) // PCM
    expect(buf.readUInt16LE(22)).toBe(1) // mono
    expect(buf.readUInt32LE(24)).toBe(8000) // 8kHz
    expect(buf.readUInt16LE(34)).toBe(16) // 16-bit
  })

  it('carries NON-zero samples — audible to the browser, inaudible to the ear', () => {
    const dataSize = buf.readUInt32LE(40)
    expect(dataSize).toBeGreaterThan(0)
    const numSamples = dataSize / 2
    let zeros = 0
    let min = 32767
    let max = -32768
    for (let i = 0; i < numSamples; i++) {
      const v = buf.readInt16LE(44 + i * 2)
      if (v === 0) zeros++
      if (v < min) min = v
      if (v > max) max = v
    }
    // The F5i-b contract: every sample = 1 (the LSB, ~-96dB). An all-zero
    // file is the bug; anything louder defeats the point of near-silence.
    expect(zeros).toBe(0)
    expect(min).toBe(1)
    expect(max).toBe(1)
  })
})

// ─── D) Source pins (F5i-c) — the silent swallow must never return ─────────

const HOOK_SRC = readFileSync(resolve(here, './useMediaSession.ts'), 'utf8')

describe('useMediaSession source pins (F5i-c)', () => {
  it('never swallows a play() rejection silently', () => {
    // The F5i-c bug was exactly this line: a swallowed NotAllowedError left
    // the keep-alive silent and the media session unrouted on iOS.
    expect(HOOK_SRC).not.toContain('.catch(() => {})')
  })

  it('logs the rejection where a live Safari session can show it', () => {
    expect(HOOK_SRC).toContain('[useMediaSession] keep-alive play rejected (will retry on next tap):')
  })

  it('arms the gesture-unlock (pointerdown retry) and the visibilitychange retry', () => {
    expect(HOOK_SRC).toContain("document.addEventListener('pointerdown'")
    expect(HOOK_SRC).toContain("document.addEventListener('visibilitychange'")
  })

  it('cleans both listeners up on release — no zombie listeners', () => {
    expect(HOOK_SRC).toContain("document.removeEventListener('pointerdown'")
    expect(HOOK_SRC).toContain("document.removeEventListener('visibilitychange'")
  })
})
