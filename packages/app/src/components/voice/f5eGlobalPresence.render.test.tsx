/**
 * F5e render tests — the global voice presence.
 *
 *   1. VoiceOrbOverlay: renders NOTHING while there is no session (presence
 *      off / flags off — the overlay is invisible until voice is alive);
 *      renders the orb while a session lives (the floating bubble exists
 *      outside the chat); a DRAG moves it and PERSISTS the position; a TAP
 *      (no movement) does not claim the gesture (the popover stays reachable).
 *   2. Interim transcript flow: the context routes partial:true frames to
 *      the interim (replace, never accumulate) and the final consolidates
 *      (interim cleared + the real row added). Asserted at the wiring level
 *      (the full provider drags Tamagui + stores + client into jsdom —
 *      overkill for this contract; the repo's lint-as-test pattern).
 *   3. InterimRow: renders the flowing phrase tenue (gray italic), with the
 *      live meta — the being-said thing, not a said thing.
 *   4. The navbar's voice door was REMOVED (Pablo, 2026.10.05): the per-agent
 *      phone button no longer renders — the presence dot and the floating orb
 *      remain the only voice surfaces. useVoicePresence keeps its own wiring
 *      contract (asserted at the wiring level).
 *
 *   cd packages/app && npx vitest run src/components/voice/f5eGlobalPresence.render.test.tsx
 */
import { fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import '../../i18n'
import { VoiceOrbOverlay } from './VoiceOrbOverlay'
import { InterimRow } from './VoiceThreadSection'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// The overlay reads the session context — mock the hook (the provider's full
// mount drags the whole render graph into jsdom; the contract here is the
// overlay's, not the provider's).
const sessionMock = {
  presence: 'off' as string,
  mode: 'conversation' as const,
  activity: 'idle' as const,
  audioLevel: 0,
  activeAgentId: null as string | null,
  lastHeard: null as string | null,
  workerName: null as string | null,
  reconnectAttempt: 0,
  isMuted: false,
  setMode: () => {},
  toggleMute: () => {},
  stopSession: vi.fn(),
}
vi.mock('../../contexts/VoiceSessionContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/VoiceSessionContext')>(
    '../../contexts/VoiceSessionContext',
  )
  return { ...actual, useVoiceSession: () => sessionMock }
})

// The flags store — voice.enabled + voice.mode-ui both on by default.
const flagsMock: Record<string, unknown> = { 'voice.enabled': true, 'voice.mode-ui': true }
vi.mock('../../store/featureFlagsStore', async () => {
  const actual =
    await vi.importActual<typeof import('../../store/featureFlagsStore')>(
      '../../store/featureFlagsStore',
    )
  return {
    ...actual,
    getResolvedFlag: (_store: unknown, key: string) => flagsMock[key],
    useFeatureFlagsStore: (sel?: (s: { flags: Record<string, unknown> }) => unknown) =>
      sel ? sel({ flags: flagsMock }) : { flags: flagsMock },
  }
})

// The navbar store — the agent cache (the orb's face).
vi.mock('../../store/navbarStore', async () => {
  const actual = await vi.importActual<typeof import('../../store/navbarStore')>(
    '../../store/navbarStore',
  )
  return {
    ...actual,
    useNavbarStore: (sel: (s: { agents: Array<{ agentId: string; name: string }> }) => unknown) =>
      sel({ agents: [{ agentId: 'agent_1', name: 'Alice' }] }),
  }
})

// The storage service — capture writes (the persisted orb position).
const storageWrites: Record<string, unknown> = {}
vi.mock('../../services/storage', () => ({
  STORAGE_KEYS: { VOICE_ORB_POS: 'teros_voice_orb_pos', VOICE_SESSION: 'teros_voice_session' },
  storage: {
    get: vi.fn(async (key: string) => storageWrites[key] ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      storageWrites[key] = value
    }),
  },
}))

// jsdom has no layout — window sizes are stubbed for the clamp math.
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 })
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 })
})
afterEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(storageWrites)) delete storageWrites[k]
})

// ─── 1. VoiceOrbOverlay ──────────────────────────────────────────────────────

describe('F5e — VoiceOrbOverlay (the persistent floating bubble)', () => {
  it('renders NOTHING while there is no session (presence off)', () => {
    sessionMock.presence = 'off'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    expect(container.querySelector('[testID="voice-orb-overlay"], [data-testid="voice-orb-overlay"]')).toBeNull()
    // Not even an empty wrapper — the overlay is invisible until voice lives.
    expect(container.textContent).toBe('')
  })

  it('renders the orb while a session lives — outside any chat window', () => {
    sessionMock.presence = 'on'
    sessionMock.activeAgentId = 'agent_1'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    // The orb is there — its a11y label carries the agent's name.
    const label = container.querySelector('[aria-label]')?.getAttribute('aria-label') ?? ''
    expect(label).toContain('Alice')
  })

  it('renders nothing with the flags off (zero regression)', () => {
    flagsMock['voice.mode-ui'] = false
    sessionMock.presence = 'on'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    expect(container.textContent).toBe('')
    flagsMock['voice.mode-ui'] = true
  })

  it('a DRAG moves the orb and PERSISTS the resting position', async () => {
    sessionMock.presence = 'on'
    sessionMock.activeAgentId = 'agent_1'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    const overlay = container.querySelector('[testID="voice-orb-overlay"], [data-testid="voice-orb-overlay"]')
    expect(overlay).not.toBeNull()

    // mousedown → mousemove (past the 5px slop) → mouseup (drop)
    fireEvent.mouseDown(overlay!, { clientX: 1100, clientY: 700 })
    fireEvent.mouseMove(document, { clientX: 900, clientY: 500 })
    fireEvent.mouseUp(document, { clientX: 900, clientY: 500 })

    // The position was persisted — the orb remembers where it was left.
    const { storage } = vi.mocked(await import('../../services/storage'))
    expect(storage.set).toHaveBeenCalledWith(
      'teros_voice_orb_pos',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    // Grab semantics: the orb moves by the DRAG DELTA from its origin (it
    // does not jump to the cursor). Origin = default bottom-right on a
    // 1200×800 viewport ({x:1150, y:742}); delta = (-200, -200) → {950, 542}.
    const stored = storageWrites['teros_voice_orb_pos'] as { x: number; y: number }
    expect(Math.round(stored.x)).toBe(950)
    expect(Math.round(stored.y)).toBe(542)
  })

  it('a TAP (no movement) does not claim the gesture — the popover stays reachable', async () => {
    sessionMock.presence = 'on'
    sessionMock.activeAgentId = 'agent_1'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    const overlay = container.querySelector('[testID="voice-orb-overlay"], [data-testid="voice-orb-overlay"]')

    // Down → up with NO movement: not a drag — nothing is persisted.
    fireEvent.mouseDown(overlay!, { clientX: 1100, clientY: 700 })
    fireEvent.mouseUp(document, { clientX: 1100, clientY: 700 })
    const { storage } = vi.mocked(await import('../../services/storage'))
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('hydrates the persisted position on mount (the orb comes back where it was left)', async () => {
    storageWrites['teros_voice_orb_pos'] = { x: 300, y: 200 }
    sessionMock.presence = 'on'
    sessionMock.activeAgentId = 'agent_1'
    const { container } = renderWithTamagui(<VoiceOrbOverlay />)
    // The hydration is async — flush it.
    await vi.waitFor(() => {
      const overlay = container.querySelector('[testID="voice-orb-overlay"], [data-testid="voice-orb-overlay"]')
      expect(overlay).not.toBeNull()
      const style = (overlay as HTMLElement).getAttribute('style') ?? ''
      // Centered on the persisted position (left = x - 26, top = y - 26).
      expect(style).toContain('left: 274px')
      expect(style).toContain('top: 174px')
    })
  })
})

// ─── 2. Interim transcript wiring (context) ─────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const CONTEXT_SRC = readFileSync(resolve(here, '../../contexts/VoiceSessionContext.tsx'), 'utf8')

describe('F5e — interim transcript wiring (the flowing live text)', () => {
  it('routes partial transcripts to the interim (replace, never accumulate)', () => {
    // The case 'transcript' must read message.partial and route through
    // handleTranscriptFrame — interim frames never enter liveTranscripts.
    expect(CONTEXT_SRC).toContain('handleTranscriptFrame(')
    expect(CONTEXT_SRC).toMatch(/message\.partial === true/)
    expect(CONTEXT_SRC).toMatch(/if \(partial && isUser\)/)
    expect(CONTEXT_SRC).toMatch(/setInterimTranscript\(text \|\| null\)/)
  })

  it('the FINAL consolidates: interim cleared + the real row added as today', () => {
    expect(CONTEXT_SRC).toMatch(/if \(isUser\) setInterimTranscript\(null\)/)
    expect(CONTEXT_SRC).toMatch(/addTranscript\(text, isUser, 'transcript', overheard\)/)
  })

  it('exposes interimTranscript on the session (the view-only live phrase)', () => {
    expect(CONTEXT_SRC).toMatch(/interimTranscript: string \| null/)
    expect(CONTEXT_SRC).toMatch(/^\s+interimTranscript,$/m)
  })

  it('the interim dies with the session (stopSession clears it)', () => {
    expect(CONTEXT_SRC).toMatch(/setInterimTranscript\(null\)/)
  })
})

// ─── 3. InterimRow (the tenue live row) ─────────────────────────────────────

describe('F5e — InterimRow (the user\'s words flowing live, tenue)', () => {
  it('renders the flowing phrase with the live meta', () => {
    const { container } = renderWithTamagui(<InterimRow text="¿me estás escuch" />)
    expect(container.textContent).toContain('¿me estás escuch')
    // The live meta — it is being said, not said yet.
    expect(container.textContent).toContain('hablando')
  })
})

// ─── 4. The navbar's voice door (wiring) ─────────────────────────────────────

const NAVBAR_SRC = readFileSync(resolve(here, '../../components/Navbar.tsx'), 'utf8')
const PRESENCE_HOOK_SRC = readFileSync(
  resolve(here, '../../hooks/voice/useVoicePresence.ts'),
  'utf8',
)

describe('F5e — the global voice door (navbar + useVoicePresence)', () => {
  it('the navbar does NOT render a per-agent phone button (removed 2026.10.05)', () => {
    // The per-agent call button was removed from the agent list. The presence
    // dot (active session) and the floating orb are the only voice surfaces.
    expect(NAVBAR_SRC).not.toMatch(/nav-voice-/)
    expect(NAVBAR_SRC).not.toContain('startVoiceFor')
    expect(NAVBAR_SRC).not.toContain('useVoicePresence')
  })

  it('useVoicePresence resolves the agent and REQUIRES a conversation channel', () => {
    // The backend rejects channel-less sessions (channel_required) — the
    // hook must resolve a channel before startSession.
    expect(PRESENCE_HOOK_SRC).toContain("client.channel.create({")
    // PoC 2026-10-31: the door may ask for the starting mode (navbar → available).
    expect(PRESENCE_HOOK_SRC).toContain('session.startSession(resolvedAgentId, undefined, chatChannelId, opts?.initialMode)')
    // The stored session for this agent is resumed (not a new channel).
    expect(PRESENCE_HOOK_SRC).toContain("stored.agentId === resolvedAgentId")
  })
})
