/**
 * pcm-processor.js mic gate tests (F5f) — the "mic cortado" fix.
 *
 * The worklet is a plain JS file served from public/ and evaluated inside an
 * AudioWorkletGlobalScope — vitest cannot import it (no exports, and jsdom has
 * no AudioWorklet). So we do what the browser does: read the source, evaluate
 * it in a closed scope with mocked AudioWorkletProcessor / registerProcessor,
 * and drive the registered class directly with synthetic audio chunks.
 *
 * Behaviors under test (the F5f acceptance criteria):
 *   1. DEFAULT (no micGate message ever): the RMS gate is ACTIVE — the exact
 *      pre-F5f behavior. Any client that never sends micGate (the legacy
 *      engine, the tablet client, a stale tab) stays byte-compatible.
 *   2. LEGACY (micGate=true): gate ACTIVE — quiet chunks while the agent
 *      speaks are dropped; loud interruptions pass.
 *   3. NATIVE (micGate=false): gate INACTIVE — the user's PCM flows ALWAYS,
 *      including quiet speech onsets while the agent speaks (the bug: the
 *      first syllables of a phrase averaged below the 0.02 RMS threshold and
 *      the whole 256ms chunk was dropped, so the STT lost the start of the
 *      word — "se me corta el micrófono").
 *   4. MUTE is unchanged in both modes (the gate change never touches the
 *      mute path).
 *   5. The gate only applies while the agent is speaking.
 *   6. The echo trade-off stays documented in the worklet source (server-side
 *      tuning only — never re-adding the client-side gate).
 *
 *   cd packages/app && npx vitest run src/contexts/__tests__/pcmProcessorMicGate.render.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const WORKLET_SRC = readFileSync(resolve(here, '../../../public/pcm-processor.js'), 'utf8')

/** The worklet's chunk size (4096 samples ≈ 256ms at 16kHz) — one _flush per full chunk. */
const BUFFER_SIZE = 4096

// ─── Worklet harness ─────────────────────────────────────────────────────────

interface Harness {
  /** The registered processor instance. */
  processor: { process: (inputs: Float32Array[][]) => boolean }
  /** The main-thread side of the processor's MessagePort (postMessage spy). */
  port: { postMessage: ReturnType<typeof vi.fn> }
  /** Send a control message to the worklet (mute / agentSpeaking / micGate). */
  send: (type: string, value: boolean) => void
}

/** Evaluate the worklet source the way the browser's AudioWorklet does. */
function loadWorklet(): Harness {
  // Captured via array push — a closure assignment to a plain let is invisible
  // to TS's control-flow analysis (it stays narrowed to the initializer), so
  // the registered class would be `never` at the construction site below.
  const captured: (new () => Harness['processor'])[] = []
  const registerProcessor = vi.fn((name: string, cls: unknown) => {
    if (name === 'pcm-processor') captured.push(cls as new () => Harness['processor'])
  })
  const postMessage = vi.fn()
  const port = {
    postMessage,
    onmessage: null as ((e: { data: { type: string; value: boolean } }) => void) | null,
  }
  // The AudioWorkletGlobalScope base class: the real one hands the processor a
  // MessagePort; ours records everything the worklet posts to the main thread.
  class AudioWorkletProcessor {
    port = port
  }
  // Indirect eval in a closed scope — exactly the two globals the worklet
  // expects, nothing else.
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', WORKLET_SRC)
  run(AudioWorkletProcessor, registerProcessor)

  expect(registerProcessor).toHaveBeenCalledTimes(1)
  expect(registerProcessor).toHaveBeenCalledWith('pcm-processor', expect.any(Function))
  const registered = captured[0]
  if (!registered) throw new Error('worklet did not register pcm-processor')

  const processor = new registered()
  const send = (type: string, value: boolean) => {
    if (!port.onmessage) throw new Error('worklet did not install port.onmessage')
    port.onmessage({ data: { type, value } })
  }
  return { processor, port, send }
}

// ─── Audio helpers ──────────────────────────────────────────────────────────

/** A full 4096-sample chunk at a constant amplitude (RMS = amplitude). */
function steadyChunk(amplitude: number): Float32Array {
  const samples = new Float32Array(BUFFER_SIZE)
  samples.fill(amplitude)
  return samples
}

/**
 * A chunk that is silence until `onsetAt`, then a soft onset — the "mic
 * cortado" scenario: the first 256ms chunk of a quiet phrase carries mostly
 * silence, so its average RMS falls below the 0.02 threshold even though
 * real speech started inside it.
 */
function onsetChunk(onsetAmplitude: number, onsetAt = BUFFER_SIZE - 96): Float32Array {
  const samples = new Float32Array(BUFFER_SIZE)
  for (let i = onsetAt; i < BUFFER_SIZE; i++) samples[i] = onsetAmplitude
  return samples
}

/** Feed one full chunk through process() — exactly one _flush per chunk. */
function feed(h: Harness, samples: Float32Array) {
  h.processor.process([[samples]])
}

/** The PCM chunks the worklet posted to the main thread. */
function postedPcm(h: Harness) {
  return h.port.postMessage.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'pcm')
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('pcm-processor mic gate (F5f)', () => {
  describe('default — no micGate message ever (legacy compatibility)', () => {
    it('gate ACTIVE: a quiet chunk while the agent speaks is dropped', () => {
      const h = loadWorklet()
      h.send('agentSpeaking', true)
      feed(h, steadyChunk(0.005)) // RMS 0.005 < 0.02
      expect(postedPcm(h)).toHaveLength(0)
    })

    it('a loud interruption passes (the gate never blocks real interruptions)', () => {
      const h = loadWorklet()
      h.send('agentSpeaking', true)
      feed(h, steadyChunk(0.3)) // RMS 0.3 >> 0.02
      expect(postedPcm(h)).toHaveLength(1)
    })

    it('a mixed silence+onset chunk is dropped (pre-F5f behavior, by design)', () => {
      const h = loadWorklet()
      h.send('agentSpeaking', true)
      feed(h, onsetChunk(0.05)) // RMS ≈ 0.0077 < 0.02
      expect(postedPcm(h)).toHaveLength(0)
    })
  })

  describe('legacy engine — micGate=true (byte-identical path)', () => {
    it('quiet dropped, loud passes — same as the default', () => {
      const h = loadWorklet()
      h.send('micGate', true)
      h.send('agentSpeaking', true)
      feed(h, steadyChunk(0.005))
      expect(postedPcm(h)).toHaveLength(0)
      feed(h, steadyChunk(0.3))
      expect(postedPcm(h)).toHaveLength(1)
    })
  })

  describe('native engine — micGate=false (the fix)', () => {
    it('a quiet chunk while the agent speaks FLOWS (gate inactive)', () => {
      const h = loadWorklet()
      h.send('micGate', false)
      h.send('agentSpeaking', true)
      feed(h, steadyChunk(0.005))
      expect(postedPcm(h)).toHaveLength(1)
    })

    it('speech onsets reach the STT — the "mic cortado" scenario', () => {
      const h = loadWorklet()
      h.send('micGate', false)
      h.send('agentSpeaking', true)
      feed(h, onsetChunk(0.05))
      expect(postedPcm(h)).toHaveLength(1)
    })

    it('the posted chunk is Int16 PCM transferred zero-copy', () => {
      const h = loadWorklet()
      h.send('micGate', false)
      h.send('agentSpeaking', true)
      feed(h, steadyChunk(0.3))
      const call = postedPcm(h)[0]
      expect((call[0] as { type: string }).type).toBe('pcm')
      const buffer = (call[0] as { buffer: ArrayBuffer }).buffer
      expect(buffer).toBeInstanceOf(ArrayBuffer)
      expect(new Int16Array(buffer)).toHaveLength(BUFFER_SIZE)
      expect(call[1]).toEqual([buffer]) // the Transferable list
    })
  })

  describe('mute — unchanged in both modes', () => {
    it('muted drops everything even with the gate off', () => {
      const h = loadWorklet()
      h.send('micGate', false)
      h.send('mute', true)
      feed(h, steadyChunk(0.3))
      expect(postedPcm(h)).toHaveLength(0)
    })

    it('muted drops everything with the gate on', () => {
      const h = loadWorklet()
      h.send('micGate', true)
      h.send('mute', true)
      feed(h, steadyChunk(0.3))
      expect(postedPcm(h)).toHaveLength(0)
    })

    it('un-muting restores the flow', () => {
      const h = loadWorklet()
      h.send('mute', true)
      h.send('mute', false)
      feed(h, steadyChunk(0.3))
      expect(postedPcm(h)).toHaveLength(1)
    })
  })

  describe('gate scope — only while the agent speaks', () => {
    it('quiet audio passes when the agent is NOT speaking, in both modes', () => {
      const legacy = loadWorklet()
      legacy.send('micGate', true)
      legacy.send('agentSpeaking', false)
      feed(legacy, steadyChunk(0.005))
      expect(postedPcm(legacy)).toHaveLength(1)

      const native = loadWorklet()
      native.send('micGate', false)
      native.send('agentSpeaking', false)
      feed(native, steadyChunk(0.005))
      expect(postedPcm(native)).toHaveLength(1)
    })
  })

  describe('echo trade-off documentation (acceptance criterion)', () => {
    it('the worklet documents the trade-off: server-side tuning, never a client-side gate', () => {
      expect(WORKLET_SRC).toContain('TRADE-OFF ECO')
      expect(WORKLET_SRC).toContain('LADO SERVER')
      expect(WORKLET_SRC).toContain('JAMÁS se')
    })
  })
})
