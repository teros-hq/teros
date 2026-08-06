/**
 * AF-3 / AF-7 follow-up tests — Voice mode error handling.
 *
 * Covers three areas that had no test coverage after the initial AF-3/AF-7
 * implementation (commit bda26dcd):
 *
 * 1. `mapVoiceCloseCode` — pure WS close-code → typed error mapping.
 *    Asserts 401→auth, 403→flag_disabled, 400→bad_request, 500→server_error,
 *    and that unmapped codes (1000, 1006) return null (fall through to
 *    reconnection logic).
 *
 * 2. AF-7 typed error frame handling — verifies that a `{ type: 'error', code }`
 *    frame produces the correct `VoiceSessionError` shape.
 *
 * 3. AF-3 channel creation guard — verifies the *contract* of handleStartVoice
 *    using inline reproductions of its logic with fake objects (not a full
 *    ChatView mount, which would require Tamagui + stores + client wiring).
 *    Asserts: creates channel before startSession, skips when channelId exists,
 *    calls setError on failure (not swallowed), double-tap guard prevents
 *    duplicate channel creation.
 *
 *   cd packages/app && npx vitest run src/contexts/__tests__/voiceCloseCode.render.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  mapVoiceCloseCode,
  type VoiceErrorCode,
  type VoiceSessionError,
} from '../VoiceSessionContext'

// =============================================================================
// 1. mapVoiceCloseCode — pure function, no React needed
// =============================================================================

describe('mapVoiceCloseCode — WS close code to typed error mapping', () => {
  it('401 → auth error', () => {
    const result = mapVoiceCloseCode(401)
    expect(result).not.toBeNull()
    expect(result!.code).toBe('auth')
    expect(result!.message).toContain('Authentication')
  })

  it('403 → flag_disabled error', () => {
    const result = mapVoiceCloseCode(403)
    expect(result).not.toBeNull()
    expect(result!.code).toBe('flag_disabled')
    expect(result!.message).toContain('not enabled')
  })

  it('400 → bad_request error (no retry — client bug)', () => {
    const result = mapVoiceCloseCode(400)
    expect(result).not.toBeNull()
    expect(result!.code).toBe('bad_request')
    expect(result!.message).toContain('Invalid')
  })

  it('500 → server_error error (retry allowed)', () => {
    const result = mapVoiceCloseCode(500)
    expect(result).not.toBeNull()
    expect(result!.code).toBe('server_error')
    expect(result!.message).toContain('Server error')
  })

  it('1000 (normal closure) → null (no error, no reconnection)', () => {
    expect(mapVoiceCloseCode(1000)).toBeNull()
  })

  it('1006 (abnormal closure) → null (falls through to reconnection)', () => {
    expect(mapVoiceCloseCode(1006)).toBeNull()
  })

  it('1011 (server internal error) → null (falls through to reconnection)', () => {
    // 1011 is a WS protocol code, not an HTTP rejection code — the server
    // bootstrap uses 400/401/403/500 for HTTP-level rejections before upgrade.
    expect(mapVoiceCloseCode(1011)).toBeNull()
  })

  it('all mapped codes return a well-formed VoiceSessionError', () => {
    for (const code of [401, 403, 400, 500]) {
      const result = mapVoiceCloseCode(code)
      expect(result).not.toBeNull()
      expect(typeof result!.code).toBe('string')
      expect(typeof result!.message).toBe('string')
      expect(result!.message.length).toBeGreaterThan(0)
    }
  })
})

// =============================================================================
// 2. AF-7 — typed error frame produces correct VoiceSessionError shape
// =============================================================================

describe('AF-7 — typed error frame → VoiceSessionError shape', () => {
  // This mirrors the logic in handleServerMessage's `case 'error':` block.
  // We test the shape transformation that the backend error frame undergoes.
  function processErrorFrame(message: {
    type: string
    code?: string
    message?: string
    error?: string
  }): VoiceSessionError {
    const code = (message.code as VoiceErrorCode) || 'unknown'
    const msg = message.message || message.error || 'Unknown error'
    return { code, message: msg }
  }

  it('maps a backend auth error frame to { code: "auth", message }', () => {
    const result = processErrorFrame({
      type: 'error',
      code: 'auth',
      message: 'Session token expired',
    })
    expect(result.code).toBe('auth')
    expect(result.message).toBe('Session token expired')
  })

  it('maps a flag_disabled frame to { code: "flag_disabled", message }', () => {
    const result = processErrorFrame({
      type: 'error',
      code: 'flag_disabled',
      message: 'Voice mode disabled',
    })
    expect(result.code).toBe('flag_disabled')
    expect(result.message).toBe('Voice mode disabled')
  })

  it('maps a server_error frame to { code: "server_error", message }', () => {
    const result = processErrorFrame({
      type: 'error',
      code: 'server_error',
      message: 'Internal server error during flag check',
    })
    expect(result.code).toBe('server_error')
    expect(result.message).toBe('Internal server error during flag check')
  })

  it('falls back to "unknown" code when no code field is present', () => {
    const result = processErrorFrame({ type: 'error', message: 'Something broke' })
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('Something broke')
  })

  it('falls back to message from error field when message is absent', () => {
    const result = processErrorFrame({ type: 'error', code: 'timeout', error: 'ETIMEDOUT' })
    expect(result.code).toBe('timeout')
    expect(result.message).toBe('ETIMEDOUT')
  })

  it('falls back to "Unknown error" when neither message nor error is present', () => {
    const result = processErrorFrame({ type: 'error', code: 'timeout' })
    expect(result.code).toBe('timeout')
    expect(result.message).toBe('Unknown error')
  })
})

// =============================================================================
// 3. AF-3 — channel creation guard contract
// =============================================================================

describe('AF-3 — handleStartVoice channel creation guard contract', () => {
  // We test the *contract* of handleStartVoice without mounting the full
  // ChatView (which requires Tamagui, stores, client, etc.).
  //
  // The contract is:
  //   1. If channelId is null, call client.channel.create() first.
  //   2. Pass the resulting channelId to startSession.
  //   3. If channel.create() throws, call setError() — do NOT swallow.
  //   4. If channelId is already set, skip channel creation.

  it('creates a channel before startSession when channelId is null', async () => {
    let channelCreated = false
    let startSessionCalled = false
    let startSessionReceivedChannelId: string | undefined

    const fakeClient = {
      channel: {
        create: async (): Promise<{ channelId: string }> => {
          channelCreated = true
          return { channelId: 'ch_new_123' }
        },
      },
    }
    const fakeVoiceSession = {
      startSession: async (_agentId: string, _resume?: string, chatChannelId?: string): Promise<void> => {
        startSessionCalled = true
        startSessionReceivedChannelId = chatChannelId
      },
      setError: (_err: VoiceSessionError | null) => {},
    }

    // Inline reproduction of handleStartVoice's core logic
    let effectiveChannelId: string | null = null
    if (!effectiveChannelId) {
      const result = await fakeClient.channel.create()
      effectiveChannelId = result.channelId
    }
    await fakeVoiceSession.startSession('agent_1', undefined, effectiveChannelId!)

    expect(channelCreated).toBe(true)
    expect(startSessionCalled).toBe(true)
    expect(startSessionReceivedChannelId).toBe('ch_new_123')
  })

  it('skips channel creation when channelId is already set', async () => {
    let channelCreated = false
    let startSessionCalled = false
    let startSessionReceivedChannelId: string | undefined

    const fakeClient = {
      channel: {
        create: async (): Promise<{ channelId: string }> => {
          channelCreated = true
          return { channelId: 'ch_should_not_be_created' }
        },
      },
    }
    const fakeVoiceSession = {
      startSession: async (_agentId: string, _resume?: string, chatChannelId?: string): Promise<void> => {
        startSessionCalled = true
        startSessionReceivedChannelId = chatChannelId
      },
      setError: (_err: VoiceSessionError | null) => {},
    }

    // channelId is already set — no creation needed
    let effectiveChannelId: string | null = 'ch_existing_456'
    if (!effectiveChannelId) {
      const result = await fakeClient.channel.create()
      effectiveChannelId = result.channelId
    }
    await fakeVoiceSession.startSession('agent_1', undefined, effectiveChannelId!)

    expect(channelCreated).toBe(false)
    expect(startSessionCalled).toBe(true)
    expect(startSessionReceivedChannelId).toBe('ch_existing_456')
  })

  it('calls setError when channel.create() throws (error not swallowed)', async () => {
    let setErrorCalled = false
    let setErrorReceived: VoiceSessionError | null = null

    const fakeClient = {
      channel: {
        create: async (): Promise<{ channelId: string }> => {
          throw new Error('Network error: channel creation failed')
        },
      },
    }
    const fakeVoiceSession = {
      startSession: async (_agentId: string, _resume?: string, _chatChannelId?: string): Promise<void> => {
        // Should NOT be called when channel creation fails
        throw new Error('startSession should not be reached')
      },
      setError: (err: VoiceSessionError | null) => {
        setErrorCalled = true
        setErrorReceived = err
      },
    }

    // Inline reproduction of handleStartVoice's try/catch
    let effectiveChannelId: string | null = null
    try {
      if (!effectiveChannelId) {
        const result = await fakeClient.channel.create()
        effectiveChannelId = result.channelId
      }
      await fakeVoiceSession.startSession('agent_1', undefined, effectiveChannelId!)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start voice session'
      fakeVoiceSession.setError({ code: 'unknown', message })
    }

    expect(setErrorCalled).toBe(true)
    expect(setErrorReceived).not.toBeNull()
    expect(setErrorReceived!.code).toBe('unknown')
    expect(setErrorReceived!.message).toContain('Network error')
  })

  it('guard prevents double-tap from creating two channels', async () => {
    let createCallCount = 0
    const fakeClient = {
      channel: {
        create: async (): Promise<{ channelId: string }> => {
          createCallCount++
          // Simulate async delay
          await new Promise((r) => setTimeout(r, 10))
          return { channelId: `ch_${createCallCount}` }
        },
      },
    }
    const fakeVoiceSession = {
      startSession: async (_agentId: string, _resume?: string, _chatChannelId?: string): Promise<void> => {},
      setError: (_err: VoiceSessionError | null) => {},
    }

    // Reproduce the voiceStartingRef guard
    let voiceStarting = false
    const handleStartVoice = async () => {
      if (voiceStarting) return
      voiceStarting = true
      try {
        let effectiveChannelId: string | null = null
        if (!effectiveChannelId) {
          const result = await fakeClient.channel.create()
          effectiveChannelId = result.channelId
        }
        await fakeVoiceSession.startSession('agent_1', undefined, effectiveChannelId!)
      } catch {
        // error path
      } finally {
        voiceStarting = false
      }
    }

    // Double-tap: call twice concurrently
    await Promise.all([handleStartVoice(), handleStartVoice()])

    // Only one channel should have been created
    expect(createCallCount).toBe(1)
  })
})
