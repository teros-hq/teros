/**
 * VoiceSessionContext micGate wiring tests (F5f).
 *
 * The provider's full mount drags the whole render graph (Tamagui, stores,
 * client wiring) into jsdom — overkill for the F5f contract. Following the
 * repo's lint-as-test pattern (retentionAdoption.render.test.ts), these
 * assertions pin the ENGINE → WORKLET MESSAGE wiring at the source level:
 *
 *   1. The worklet node receives {type:'micGate', value:!nativeEngineEnabled}
 *      at creation time (startAudioCapture) — native → false, legacy → true.
 *   2. A dedicated effect re-syncs micGate when the engine flag changes at
 *      runtime (the worklet may already be alive when the flag flips).
 *   3. The micGate message is engine-driven — NOT a reuse of agentSpeaking
 *      (the task's design rule: agentSpeaking keeps its original semantics
 *      in both engines).
 *   4. The worklet defaults to gate ON, so a client that never sends micGate
 *      keeps the legacy behavior (asserted behaviorally in
 *      pcmProcessorMicGate.render.test.ts).
 *
 *   cd packages/app && npx vitest run src/contexts/__tests__/voiceMicGateWiring.render.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const CONTEXT_SRC = readFileSync(resolve(here, '../VoiceSessionContext.tsx'), 'utf8')

describe('VoiceSessionContext micGate wiring (F5f)', () => {
  it('sends micGate=!nativeEngineEnabled to the worklet at creation time', () => {
    // startAudioCapture: the initial sync block (mute + agentSpeaking + micGate)
    expect(CONTEXT_SRC).toContain(
      "workletNode.port.postMessage({ type: 'micGate', value: !nativeEngineEnabled })",
    )
  })

  it('re-syncs micGate when the engine flag changes at runtime (dedicated effect)', () => {
    // The effect body must post micGate driven by nativeEngineEnabled, gated
    // on the flag as a dependency so a runtime flip re-sends the message.
    const effectBody =
      /useEffect\(\(\)\s*=>\s*\{[^}]*workletNodeRef\.current\?\.port\.postMessage\(\{\s*type:\s*'micGate',\s*value:\s*!nativeEngineEnabled\s*\}\)[^}]*\},\s*\[nativeEngineEnabled\]\)/
    expect(effectBody.test(CONTEXT_SRC)).toBe(true)
  })

  it('agentSpeaking keeps its original semantics — not repurposed for the gate', () => {
    // The design rule: micGate is a NEW message; agentSpeaking stays a plain
    // speaking indicator in BOTH engines. Every agentSpeaking postMessage
    // still posts a speaking state (ref value or literal true/false) — none
    // is driven by nativeEngineEnabled (that would be the forbidden reuse).
    const agentSpeakingPosts = CONTEXT_SRC.match(
      /postMessage\(\{\s*type:\s*'agentSpeaking',\s*value:\s*[^}]+\}/g,
    )
    expect(agentSpeakingPosts).not.toBeNull()
    expect((agentSpeakingPosts ?? []).length).toBeGreaterThan(4)
    for (const post of agentSpeakingPosts ?? []) {
      expect(post).not.toContain('nativeEngineEnabled')
      expect(post).toMatch(
        /value:\s*(agentSpeakingRef\.current|true|false)\s*\}/,
      )
    }
  })

  it('startAudioCapture declares nativeEngineEnabled as a dependency', () => {
    // The callback reads nativeEngineEnabled now — a stale closure would send
    // the wrong micGate mode after a runtime flag flip.
    expect(CONTEXT_SRC).toContain(
      '[monitorAudioLevel, sendPcmBuffer, nativeEngineEnabled]',
    )
  })
})
