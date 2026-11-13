/**
 * useTtsPlayer render tests — the native engine's audio player (F3d).
 *
 * Covers the acceptance surfaces of the player (AudioContext mocked, the
 * useEarcons.render.test.ts pattern — jsdom has no WebAudio):
 *
 *   1. FRAMING: chunks → sentence accumulator → decodeAudioData per COMPLETE
 *      sentence (the ID3 magic delimits sentences — verified against the real
 *      provider output). Chunks of one sentence never decode separately.
 *   2. ORDER: strict FIFO — one source at a time, chained via onended. The
 *      arrival order is the playback order; never two sources started while
 *      one sounds.
 *   3. INTERRUPT: stop() kills the in-flight source, empties the queue, and
 *      drops in-flight decodes (generation counter). onPlaybackEnded does
 *      NOT fire (an interrupt is not a completion).
 *   4. MARKS: speaking_started re-arms; speaking_ended flushes the last
 *      sentence; the "back to idle" edge (onPlaybackEnded) fires when the
 *      queue DRAINS — not at the mark itself, and not while a decode is
 *      still in flight.
 *   5. DEGRADATION: no AudioContext at all (jsdom/native) → silent no-op,
 *      never a throw.
 *
 * The decode chain is asynchronous (decodeAudioData → microtask → queue →
 * source.start), so every "feed then assert" step goes through `flush()` —
 * a macrotask boundary that settles ALL pending microtasks (a single
 * `await Promise.resolve()` only advances one tick and races the chain).
 *
 *   cd packages/app && npx vitest run src/hooks/voice/useTtsPlayer.render.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  decodeBase64ToBytes,
  startsNewSentence,
  useTtsPlayer,
} from './useTtsPlayer'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Settle every pending microtask (decode → queue → start chain). */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Build a fake sentence MP3: ID3 magic + payload bytes. */
function sentenceMp3(index: number, size = 5000): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes[0] = 0x49 // I
  bytes[1] = 0x44 // D
  bytes[2] = 0x33 // 3
  bytes[3] = index // which sentence this is (for order assertions)
  return bytes
}

/** Slice a sentence MP3 into ~3 KB base64 chunks — the backend's delivery. */
function chunkSentence(mp3: Uint8Array, chunkSize = 3072): string[] {
  const chunks: string[] = []
  for (let i = 0; i < mp3.length; i += chunkSize) {
    const slice = mp3.subarray(i, i + chunkSize)
    let binary = ''
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j])
    chunks.push(btoa(binary))
  }
  return chunks
}

/** A fake AudioBuffer — identity is all the queue needs. */
function fakeBuffer(): AudioBuffer {
  return { duration: 1 } as unknown as AudioBuffer
}

/**
 * The mocked AudioContext: records every decode + every started source.
 * decodeAudioData resolves on a microtask (like the real async decode).
 */
function makeMockContext() {
  const decodeCalls: ArrayBuffer[] = []
  const started: {
    buffer: AudioBuffer | null
    onended: (() => void) | null
    stop: ReturnType<typeof vi.fn>
  }[] = []

  const ctx = {
    state: 'running',
    destination: { connect: vi.fn() },
    resume: vi.fn(),
    close: vi.fn(),
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
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      // Record starts: which buffer, with which onended, and the stop spy.
      const origStart = source.start.bind(source)
      source.start = vi.fn(() => {
        started.push({ buffer: source.buffer, onended: source.onended, stop: source.stop })
        origStart()
      })
      return source
    }),
    decodeAudioData: vi.fn((data: ArrayBuffer, ok: (b: AudioBuffer) => void) => {
      decodeCalls.push(data)
      queueMicrotask(() => ok(fakeBuffer()))
      return undefined // callback form (Safari-style) — no promise
    }),
  }

  return { ctx, decodeCalls, started }
}

// =============================================================================

describe('startsNewSentence / decodeBase64ToBytes (pure framing helpers)', () => {
  it('detects the ID3 magic at byte 0 — the sentence delimiter', () => {
    expect(startsNewSentence(sentenceMp3(0, 10))).toBe(true)
    // A mid-sentence chunk: MPEG frames, no ID3 at byte 0.
    const mid = new Uint8Array([0xff, 0xfb, 0x90, 0xc0, 0x00, 0x00])
    expect(startsNewSentence(mid)).toBe(false)
    expect(startsNewSentence(new Uint8Array(0))).toBe(false)
    expect(startsNewSentence(new Uint8Array([0x49, 0x44]))).toBe(false)
  })

  it('round-trips base64 → bytes', () => {
    const bytes = sentenceMp3(7, 100)
    const b64 = btoa(String.fromCharCode(...bytes))
    expect(decodeBase64ToBytes(b64)).toEqual(bytes)
  })
})

describe('useTtsPlayer — FIFO order + sentence framing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('decodes ONE complete mp3 per sentence — never a partial chunk', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())

    // Sentence 1 (5000 bytes → 2 chunks) + sentence 2 (4000 bytes → 2 chunks).
    const s1 = sentenceMp3(1, 5000)
    const s2 = sentenceMp3(2, 4000)

    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(s1)) result.current.feedChunk(c)
      // Sentence 2's first chunk carries the ID3 → sentence 1 is decoded NOW.
      for (const c of chunkSentence(s2)) result.current.feedChunk(c)
      // The stream ends → the last sentence (s2) is flushed by the mark.
      result.current.onSpeakingEnded()
      await flush()
    })

    // Two sentences decoded — each a COMPLETE mp3 (full byte length).
    expect(mock.decodeCalls.length).toBe(2)
    expect(mock.decodeCalls[0].byteLength).toBe(s1.length)
    expect(mock.decodeCalls[1].byteLength).toBe(s2.length)
  })

  it('strict FIFO: one source at a time, chained via onended', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())

    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      for (const c of chunkSentence(sentenceMp3(2, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })

    // Both sentences decoded + queued, but only the FIRST source started.
    expect(mock.decodeCalls.length).toBe(2)
    expect(mock.started.length).toBe(1)
    expect(result.current.isPlaying).toBe(true)

    // The first source ends → the second starts (the chain).
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(mock.started.length).toBe(2)

    // The queue drains → not playing anymore.
    await act(async () => {
      mock.started[1].onended?.()
    })
    expect(result.current.isPlaying).toBe(false)
  })

  it('speaking_ended flushes the LAST sentence (no next ID3 to close it)', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())

    // A single sentence, never followed by another — only speaking_ended
    // closes it.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      await flush()
    })
    expect(mock.decodeCalls.length).toBe(0) // still accumulating

    await act(async () => {
      result.current.onSpeakingEnded()
      await flush()
    })
    expect(mock.decodeCalls.length).toBe(1) // flushed by the mark
  })
})

describe('useTtsPlayer — interrupt + marks → activity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stop() kills the in-flight source, empties the queue, drops decodes', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())
    let ended = false
    act(() => {
      result.current.setOnPlaybackEnded(() => { ended = true })
    })

    // Two sentences: the first is sounding, the second is queued.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      for (const c of chunkSentence(sentenceMp3(2, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })
    expect(mock.started.length).toBe(1)
    expect(result.current.isPlaying).toBe(true)

    // INTERRUPT: the user cut the response.
    await act(async () => {
      result.current.stop()
    })

    // The in-flight source was stopped NOW (source.stop called on it).
    expect(mock.started[0].stop).toHaveBeenCalled()
    expect(result.current.isPlaying).toBe(false)

    // The stale onended must NOT resurrect the queue (the chain is dead).
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(mock.started.length).toBe(1) // the second never started
    // An interrupt is NOT a completion — the drain edge must not fire.
    expect(ended).toBe(false)
  })

  it('in-flight decodes are dropped after stop() (generation counter)', async () => {
    const mock = makeMockContext()
    // A decode that resolves LATE — after the interrupt lands.
    const ctx = mock.ctx as unknown as {
      decodeAudioData: (d: ArrayBuffer, ok: (b: AudioBuffer) => void) => undefined
    }
    let pendingOk: ((b: AudioBuffer) => void) | null = null
    ctx.decodeAudioData = vi.fn((_d, ok) => {
      pendingOk = ok
      return undefined
    })
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())

    await act(async () => {
      result.current.onSpeakingStarted()
      result.current.feedChunk(btoa('ID3-late-decode-payload'))
      result.current.onSpeakingEnded() // triggers the (pending) decode
    })

    // The decode is still in flight — interrupt NOW.
    await act(async () => {
      result.current.stop()
    })

    // The late decode resolves — its result must be DROPPED: nothing started.
    await act(async () => {
      pendingOk?.(fakeBuffer())
      await flush()
    })
    expect(mock.started.length).toBe(0)
    expect(result.current.isPlaying).toBe(false)
  })

  it('onPlaybackEnded fires when the queue DRAINS after speaking_ended', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())
    let endedCount = 0
    act(() => {
      result.current.setOnPlaybackEnded(() => { endedCount += 1 })
    })

    // One sentence: fed, flushed by the mark, decoded, sounding.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })
    expect(mock.started.length).toBe(1)
    // The mark alone did NOT fire the edge — the audio is still sounding.
    expect(endedCount).toBe(0)
    expect(result.current.isPlaying).toBe(true)

    // The last source ends → the queue drained → the edge fires ONCE.
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(endedCount).toBe(1)
    expect(result.current.isPlaying).toBe(false)

    // A stale repeat onended must not fire it again.
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(endedCount).toBe(1)
  })

  it('the edge does not fire while a decode is still in flight', async () => {
    const mock = makeMockContext()
    // A decode that resolves LATE — after the mark lands.
    const ctx = mock.ctx as unknown as {
      decodeAudioData: (d: ArrayBuffer, ok: (b: AudioBuffer) => void) => undefined
    }
    let pendingOk: ((b: AudioBuffer) => void) | null = null
    ctx.decodeAudioData = vi.fn((_d, ok) => {
      pendingOk = ok
      return undefined
    })
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())
    let endedCount = 0
    act(() => {
      result.current.setOnPlaybackEnded(() => { endedCount += 1 })
    })

    // The sentence is fed; the mark lands while its decode is in flight.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
    })
    // The edge must NOT have fired at the mark (a decode is still coming).
    expect(endedCount).toBe(0)

    // The decode lands → the sentence sounds → then drains → the edge fires.
    await act(async () => {
      pendingOk?.(fakeBuffer())
      await flush()
    })
    expect(mock.started.length).toBe(1)
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(endedCount).toBe(1)
  })

  it('speaking_started re-arms the drain edge for the next turn', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())
    let endedCount = 0
    act(() => {
      result.current.setOnPlaybackEnded(() => { endedCount += 1 })
    })

    // Turn 1: sentence → mark → sounding → drained.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })
    await act(async () => {
      mock.started[0].onended?.()
    })
    expect(endedCount).toBe(1)

    // Turn 2: the same ceremony fires the edge again.
    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(2, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })
    expect(mock.started.length).toBe(2)
    await act(async () => {
      mock.started[1].onended?.()
    })
    expect(endedCount).toBe(2)
  })

  it('a corrupt sentence is skipped — the turn keeps flowing', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())

    // Sentence 1 decodes fine; sentence 2 is corrupt (decode fails).
    const s1 = sentenceMp3(1, 4000)
    const s2 = sentenceMp3(2, 4000)
    let call = 0
    const ctx = mock.ctx as unknown as {
      decodeAudioData: (
        d: ArrayBuffer,
        ok: (b: AudioBuffer) => void,
        fail: (e: unknown) => void,
      ) => undefined
    }
    ctx.decodeAudioData = vi.fn((d: ArrayBuffer, ok: (b: AudioBuffer) => void, fail: (e: unknown) => void) => {
      // The replacement must keep recording — decodeCalls is the assertion.
      mock.decodeCalls.push(d)
      call += 1
      if (call === 2) {
        queueMicrotask(() => fail(new Error('corrupt mp3')))
      } else {
        queueMicrotask(() => ok(fakeBuffer()))
      }
      return undefined
    })

    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(s1)) result.current.feedChunk(c)
      for (const c of chunkSentence(s2)) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
      await flush()
    })

    // Sentence 1 played; sentence 2 skipped — no crash, no stall.
    expect(mock.decodeCalls.length).toBe(2)
    expect(mock.started.length).toBe(1)
  })
})

describe('useTtsPlayer — degradation + mute', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('no AudioContext at all → silent no-op, never a throw (jsdom/native)', () => {
    const { result } = renderHook(() => useTtsPlayer())
    expect(() => {
      result.current.onSpeakingStarted()
      result.current.feedChunk(btoa('ID3-any-payload'))
      result.current.onSpeakingEnded()
      result.current.stop()
      result.current.setMuted(true)
    }).not.toThrow()
    expect(result.current.isPlaying).toBe(false)
    expect(result.current.getAnalyser()).toBeNull()
  })

  it('mute while speaking is a cut (the legacy ceremony)', async () => {
    const mock = makeMockContext()
    vi.stubGlobal('AudioContext', vi.fn(function () { return mock.ctx }))

    const { result } = renderHook(() => useTtsPlayer())
    let ended = false
    act(() => {
      result.current.setOnPlaybackEnded(() => { ended = true })
    })

    await act(async () => {
      result.current.onSpeakingStarted()
      for (const c of chunkSentence(sentenceMp3(1, 4000))) result.current.feedChunk(c)
      result.current.onSpeakingEnded()
      await flush()
    })
    expect(mock.started.length).toBe(1)

    await act(async () => {
      result.current.setMuted(true)
    })
    // The in-flight source was stopped and the queue emptied.
    expect(mock.started[0].stop).toHaveBeenCalled()
    expect(result.current.isPlaying).toBe(false)
    // Mute is not a completion either — no drain edge.
    expect(ended).toBe(false)
  })
})
