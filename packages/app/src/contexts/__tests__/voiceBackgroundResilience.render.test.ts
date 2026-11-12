/**
 * F5g — background resilience tests.
 *
 * Two surfaces, two strategies (both established repo patterns):
 *
 * A) useTtsPlayer.resume() — BEHAVIORAL (renderHook + mocked AudioContext,
 *    the useTtsPlayer.render.test.ts pattern): a suspended context (the
 *    browser suspended it while the tab was hidden) is resumed; a running
 *    or closed context is left alone; no context at all → silent no-op.
 *
 * B) VoiceSessionContext visibilitychange wiring — SOURCE-LEVEL (the
 *    voiceMicGateWiring.render.test.ts lint-as-test pattern): mounting the
 *    full provider drags Tamagui + stores into jsdom for what is a pure
 *    event-wiring contract. The assertions pin:
 *      1. A visibilitychange listener is registered (and cleaned up).
 *      2. On visible + live session, every AudioContext the browser may
 *         have suspended is resumed (capture, playback, TTS player).
 *      3. The resume is gated on a live session (activeAgentIdRef) — no
 *         session, no resume (nothing to resume).
 *      4. NOTHING runs on 'hidden' — hiding the tab must never pause or
 *         close anything (the whole point of F5g: the session survives).
 *      5. No handler closes/pauses the session on pagehide/beforeunload —
 *         the audit's negative result, pinned so it stays true.
 *
 *   cd packages/app && npx vitest run src/contexts/__tests__/voiceBackgroundResilience.render.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTtsPlayer } from '../../hooks/voice/useTtsPlayer'

const here = dirname(fileURLToPath(import.meta.url))
const CONTEXT_SRC = readFileSync(
  resolve(here, '../VoiceSessionContext.tsx'),
  'utf8',
)

// ─── A) useTtsPlayer.resume() — behavioral ───────────────────────────────────

/** A minimal AudioContext mock whose state/resume are observable. */
function makeContext(state: 'running' | 'suspended' | 'closed') {
  return {
    state,
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    destination: { connect: vi.fn() },
    createGain: vi.fn(() => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      frequencyBinCount: 8,
      connect: vi.fn(),
      getByteFrequencyData: vi.fn(),
    })),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    decodeAudioData: vi.fn((_d: ArrayBuffer, ok: (b: AudioBuffer) => void) => {
      queueMicrotask(() => ok({ duration: 1 } as unknown as AudioBuffer))
      return undefined
    }),
  }
}

describe('useTtsPlayer.resume() — background suspension recovery (F5g)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('resumes a context the browser suspended while the tab was hidden', async () => {
    const ctx = makeContext('suspended')
    vi.stubGlobal('AudioContext', vi.fn(() => ctx))

    const { result } = renderHook(() => useTtsPlayer())
    // Force the graph to exist (the player creates its context lazily).
    await act(async () => {
      result.current.onSpeakingStarted()
      result.current.feedChunk(btoa('ID3xxxx'))
      result.current.onSpeakingEnded()
      await new Promise((r) => setTimeout(r, 0))
    })

    // The browser suspended it while the tab was hidden.
    ctx.state = 'suspended'

    await act(async () => {
      result.current.resume()
    })

    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  it('does NOT touch a running context (resume is a no-op)', async () => {
    const ctx = makeContext('running')
    vi.stubGlobal('AudioContext', vi.fn(() => ctx))

    const { result } = renderHook(() => useTtsPlayer())
    await act(async () => {
      result.current.onSpeakingStarted()
      result.current.feedChunk(btoa('ID3xxxx'))
      result.current.onSpeakingEnded()
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      result.current.resume()
    })

    expect(ctx.resume).not.toHaveBeenCalled()
  })

  it('does NOT touch a closed context (session already stopped)', async () => {
    const ctx = makeContext('closed')
    vi.stubGlobal('AudioContext', vi.fn(() => ctx))

    const { result } = renderHook(() => useTtsPlayer())
    await act(async () => {
      result.current.onSpeakingStarted()
      result.current.feedChunk(btoa('ID3xxxx'))
      result.current.onSpeakingEnded()
      await new Promise((r) => setTimeout(r, 0))
    })
    ctx.state = 'closed'

    await act(async () => {
      result.current.resume()
    })

    expect(ctx.resume).not.toHaveBeenCalled()
  })

  it('is a silent no-op with no AudioContext at all (jsdom/native)', () => {
    vi.stubGlobal('AudioContext', undefined)
    const { result } = renderHook(() => useTtsPlayer())
    expect(() => result.current.resume()).not.toThrow()
  })
})

// ─── B) VoiceSessionContext — visibilitychange wiring (source-level) ────────

describe('VoiceSessionContext background resilience wiring (F5g)', () => {
  it('registers a visibilitychange listener (and removes it on cleanup)', () => {
    // The effect adds the listener while mounted and removes it in cleanup.
    expect(CONTEXT_SRC).toContain(
      "document.addEventListener('visibilitychange', handleVisibilityChange)",
    )
    expect(CONTEXT_SRC).toContain(
      "document.removeEventListener('visibilitychange', handleVisibilityChange)",
    )
  })

  it('on visible + live session: resumes capture, playback AND the TTS player contexts', () => {
    // The handler gates on visible + a live session, then resumes all three
    // surfaces the browser may have suspended while hidden.
    expect(CONTEXT_SRC).toContain(
      "if (document.visibilityState !== 'visible') return",
    )
    expect(CONTEXT_SRC).toContain('if (activeAgentIdRef.current === null) return')
    expect(CONTEXT_SRC).toContain(
      "resumeSuspendedContext(audioContextRef.current, 'capture')",
    )
    expect(CONTEXT_SRC).toContain(
      "resumeSuspendedContext(playbackContextRef.current, 'playback')",
    )
    // Through the ref (the player literal is re-created every render — the
    // listener must attach once, not per re-render).
    expect(CONTEXT_SRC).toContain('ttsPlayerRef.current.resume()')
  })

  it('resumeSuspendedContext only resumes a SUSPENDED context (running/closed untouched)', () => {
    // The guard: null/closed/running contexts never get a resume() call.
    expect(CONTEXT_SRC).toContain(
      "if (!ctx || ctx.state !== 'suspended') return",
    )
  })

  it('NOTHING runs on hidden — hiding the tab must never pause the session', () => {
    // The only visibilityState read in the handler is the 'visible' early
    // return: there is no 'hidden' branch that pauses/closes/stops anything.
    const handlerBody = CONTEXT_SRC.match(
      /const handleVisibilityChange = \(\) => \{[\s\S]*?\n    \};/,
    )
    expect(handlerBody).not.toBeNull()
    const body = handlerBody?.[0] ?? ''
    expect(body).toContain("visibilityState !== 'visible'")
    expect(body).not.toContain("'hidden'")
    expect(body).not.toContain('stopSession')
    expect(body).not.toContain('wsRef.current?.close')
    expect(body).not.toContain('pause')
  })

  it('no pagehide/beforeunload handler kills the session (audit pinned)', () => {
    // The audit's negative result: no handler on pagehide/beforeunload
    // closes the WS or stops the session — pinned so it stays true.
    expect(CONTEXT_SRC).not.toContain("'pagehide'")
    expect(CONTEXT_SRC).not.toContain("'beforeunload'")
    // The only stopSession-on-unmount is the provider's own cleanup effect
    // (app close/logout) — it must NOT be wired to document visibility.
    const unmountCleanup = CONTEXT_SRC.match(
      /useEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?stopSession\(true\)[\s\S]*?\}, \[\]\)/,
    )
    expect(unmountCleanup).not.toBeNull()
  })

  it('wake lock stays active while a session is live (Pablo\u2019s commit, verified not re-implemented)', () => {
    // The wake lock (commit 231e0c66a) is session-scoped: active while
    // activeAgentId !== null — never global.
    expect(CONTEXT_SRC).toContain('useWakeLock(activeAgentId !== null)')
  })
})
