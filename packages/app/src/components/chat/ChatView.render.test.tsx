import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { TamaguiProvider, Theme } from 'tamagui'
import config from '../../../tamagui.config'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { colors as semanticColors, surface } from '../mca/primitives/colors'

/**
 * TER-461 — máquina de estados de VISTA de ChatView (no el render de mensajes).
 *
 * ChatView decide, por precedencia de early-returns, qué pantalla mostrar:
 *   1. notFound  (gana sobre todo)        → texto conversation.notFound
 *   2. loading   (isLoading || !conversation || !user) → spinner, sin composer
 *   3. empty     (isChatReady && messageIds.length === 0, y no-voz) → startConversation
 *   4. lista     (resto)                  → FlatList + composer
 *
 * Esa precedencia + los guards son lógica de plataforma que puede romperse a
 * distancia (invertir un guard, cambiar `||` por `&&`, quitar `isChatReady`).
 *
 * El grafo real de ChatView es enorme (InputComposer/Lexical 60KB, MessageItem,
 * ChatHeader, hooks WS). Se aísla mockeando los hooks (para CONTROLAR el estado) y
 * los componentes pesados (no-ops). `useChatChannel` y `useChatStore` se controlan
 * por test; `react-i18next` se mockea con `t` determinista para afirmar la clave.
 * TerosLoading e InputComposer exponen un testid para distinguir spinner vs vista
 * principal (el composer solo se monta tras pasar los early-returns).
 */

const h = vi.hoisted(() => ({
  channel: { value: {} as Record<string, unknown> },
  store: { value: { channelMessages: {}, messages: {}, channels: {} } as Record<string, unknown> },
  loadingColors: { value: [] as Array<string | undefined> },
  // v1.4.4: last suggestedPrompts the mocked InputComposer received
  // (null = prop not passed / undefined).
  composerPrompts: { value: null as string[] | null },
}))

// --- hooks de chat: controlados por test ----------------------------------
vi.mock('../../hooks/chat/useChatChannel', () => ({ useChatChannel: () => h.channel.value }))
vi.mock('../../store/chatStore', () => ({
  useChatStore: Object.assign((selector: (s: unknown) => unknown) => selector(h.store.value), {
    getState: () => h.store.value,
  }),
}))
vi.mock('../../hooks/chat/useChatInput', () => ({
  useChatInput: () => ({
    handleSend: vi.fn(),
    handleRetryMessage: vi.fn(),
    handleRenameChannel: vi.fn(),
    handleArchive: vi.fn(),
  }),
}))
vi.mock('../../hooks/chat/useChatPermissions', () => ({ useChatPermissions: () => ({}) }))
vi.mock('../../hooks/chat/usePermissionGroups', () => ({
  usePermissionGroups: () => ({ groups: [], groupByAnchorId: new Map(), groupByFirstPendingId: new Map() }),
}))
vi.mock('../../hooks/chat/useChatScroll', () => ({
  useChatScroll: () => ({ listRef: { current: null }, scrollToBottom: vi.fn() }),
}))
vi.mock('../../contexts/VoiceSessionContext', () => ({
  useVoiceSession: () => ({
    state: 'idle',
    isConnected: false,
    activeAgentId: undefined,
    activeChatChannelId: undefined,
    transcripts: [],
    historicTranscripts: [],
    liveTranscripts: [],
    audioLevel: 0,
    isMuted: false,
    startSession: vi.fn(),
    stopSession: vi.fn(),
    toggleMute: vi.fn(),
  }),
}))
vi.mock('../../store/featureFlagsStore', () => {
  // Zustand store shape: callable with a selector, plus .getState(). The old
  // object-only mock broke useFeatureFlag's useFeatureFlagsStore(selector)
  // call — pre-existing since the scope refactor (useScopeToggle → muw.enabled)
  // landed after this test's last CI fix.
  const useFeatureFlagsStore = (selector?: (s: { flags: Record<string, unknown> }) => unknown) =>
    selector ? selector({ flags: {} }) : { flags: {} }
  useFeatureFlagsStore.getState = () => ({ flags: {} })
  return {
    useFeatureFlagsStore,
    getResolvedFlag: () => false, // voice.enabled = false
  }
})
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ channel: { stopMessage: vi.fn(), transcribeAudio: vi.fn() } }),
}))

// --- i18n determinista -----------------------------------------------------
vi.mock('react-i18next', () => ({
  // LetterEmptyState (La Carta) reads i18n.language — the mock must provide it.
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  // F3b: the voice thread components (VoiceThreadSection → getDateLocale)
  // pull src/i18n/index.ts into this test's module graph, and that module
  // calls i18n.use(initReactI18next) at import time — the mock must provide it.
  initReactI18next: { type: '3rdParty', init: () => {} },
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
// F3c: the error banner's auth action pulls expo-router (useRouter) into this
// test's module graph — the real package drags the native app in and breaks
// collection (Unexpected token '<'). Mock the router surface ChatView uses.
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
  useLocalSearchParams: () => ({}),
}))

// --- componentes pesados: no-ops (con testid donde hace falta) -------------
vi.mock('../TerosLoading', async () => {
  const React = await import('react')
  // The mock exposes the resolved COLOR (bug 2026-10-06: the thinking dot drew
  // fixed indigoDark #1C0252 — black-on-black in dark) so tests can pin it
  // per theme. The color is captured into `h.loadingColors` on every render.
  return {
    TerosLoading: ({ color }: { color?: string }) => {
      h.loadingColors.value.push(color)
      return React.createElement('div', { 'data-testid': 'teros-loading' })
    },
  }
})
vi.mock('../InputComposer', async () => {
  const React = await import('react')
  // v1.4.4: capture the suggestedPrompts prop so the chips' visibility gate
  // (suggestedPromptsSuppressed) is assertable — the no-op mock hid it.
  return {
    InputComposer: (props: { suggestedPrompts?: string[] }) => {
      h.composerPrompts.value = props.suggestedPrompts ?? null
      return React.createElement('div', { 'data-testid': 'input-composer' })
    },
  }
})
vi.mock('../MessageItem', () => ({ MessageItem: () => null }))
vi.mock('./ChatHeader', () => ({ ChatHeader: () => null }))
vi.mock('../Avatar', () => ({ Avatar: () => null }))
vi.mock('../voice/VoiceControlsBar', () => ({ VoiceControlsBar: () => null }))
vi.mock('../mca', () => ({ PermissionContext: { Provider: ({ children }: { children: unknown }) => children } }))
vi.mock('../mca/primitives/GroupedPermissionPanel', () => ({
  PermissionGroupHeader: () => null,
  PermissionGroupFooter: () => null,
}))
// La Carta (d07e9c91e) — heavy live-letter component rendered in the empty
// state; not the subject of this view-state machine, so no-op it with a
// testid so the empty-state branch stays assertable.
vi.mock('./LetterEmptyState', async () => {
  const React = await import('react')
  return { LetterEmptyState: () => React.createElement('div', { 'data-testid': 'letter-empty-state' }) }
})

import { ChatView } from './ChatView'

const CH = 'ch_test'

/** Estado base "todo sano": canal cargado, listo, sin voz. Los tests sobrescriben. */
function setChannel(overrides: Record<string, unknown> = {}) {
  h.channel.value = {
    user: { userId: 'u1' },
    conversation: { title: 'T', participants: [] },
    connected: true,
    isLoading: false,
    notFound: false,
    agentName: 'A',
    agentAvatarUrl: null,
    agentRole: null,
    modelString: '',
    modelName: '',
    providerName: '',
    workspaceInfo: null,
    tokenBudget: null,
    isChatReady: true,
    hasMoreMessages: false,
    isLoadingMore: false,
    conversationInitialized: true,
    justSentMessage: false,
    setConversation: vi.fn(),
    setIsChatReady: vi.fn(),
    setModelString: vi.fn(),
    setModelName: vi.fn(),
    setProviderName: vi.fn(),
    loadMoreMessages: vi.fn(),
    ...overrides,
  }
}

function setMessages(ids: string[]) {
  h.store.value = {
    channelMessages: { [CH]: ids },
    messages: Object.fromEntries(ids.map((id) => [id, { status: 'sent' }])),
    channels: {},
  }
}

beforeEach(() => {
  setChannel()
  setMessages([])
  h.loadingColors.value.length = 0
  h.composerPrompts.value = null
})

describe('ChatView — máquina de estados de vista', () => {
  it('notFound: muestra el aviso de canal no encontrado y NO el composer', () => {
    setChannel({ notFound: true })
    const { getByText, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(getByText('conversation.notFound')).toBeTruthy()
    expect(queryByTestId('input-composer')).toBeNull()
  })

  it('notFound tiene prioridad sobre loading (aunque isLoading sea true)', () => {
    setChannel({ notFound: true, isLoading: true })
    const { getByText, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(getByText('conversation.notFound')).toBeTruthy()
    // si loading ganara, no habría texto notFound y solo el spinner
  })

  it('loading por isLoading=true: spinner, sin composer ni notFound', () => {
    setChannel({ isLoading: true })
    const { queryByTestId, queryByText } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('teros-loading')).toBeTruthy()
    expect(queryByTestId('input-composer')).toBeNull()
    expect(queryByText('conversation.notFound')).toBeNull()
  })

  it('loading por conversation ausente (isLoading=false): spinner', () => {
    setChannel({ isLoading: false, conversation: null })
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('teros-loading')).toBeTruthy()
    expect(queryByTestId('input-composer')).toBeNull()
  })

  it('loading por user ausente (isLoading=false, conversation presente): spinner', () => {
    setChannel({ isLoading: false, user: null })
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('teros-loading')).toBeTruthy()
    expect(queryByTestId('input-composer')).toBeNull()
  })

  it('empty: canal listo y sin mensajes → La Carta (LetterEmptyState) + composer (sin spinner)', async () => {
    setChannel({ isChatReady: true })
    setMessages([])
    const { getByTestId, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    // The LetterEmptyState mock uses an async factory (await import('react')),
    // which may not resolve synchronously in CI. waitFor ensures the mock
    // component is mounted before asserting its testid.
    // Since La Carta (d07e9c91e) the empty state renders LetterEmptyState
    // instead of the old startConversation button.
    await waitFor(() => expect(getByTestId('letter-empty-state')).toBeTruthy())
    expect(queryByTestId('input-composer')).toBeTruthy() // ya en la vista principal
    expect(queryByTestId('teros-loading')).toBeNull() // isChatReady=true → sin overlay
  })

  it('no-empty: canal listo con mensajes → sin La Carta (renderiza la lista)', () => {
    setChannel({ isChatReady: true })
    setMessages(['m1'])
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('letter-empty-state')).toBeNull()
    expect(queryByTestId('input-composer')).toBeTruthy()
  })

  it('empty requiere isChatReady: no-listo y sin mensajes → NO La Carta, sí overlay', () => {
    setChannel({ isChatReady: false })
    setMessages([])
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('letter-empty-state')).toBeNull() // el guard isChatReady evita el empty
    expect(queryByTestId('teros-loading')).toBeTruthy() // overlay !isChatReady
    expect(queryByTestId('input-composer')).toBeTruthy() // ya en vista principal
  })
})

describe('ChatView — spinner colors resolve the ACTIVE theme (bug 2026-10-06)', () => {
  it('thinking indicator rides the dark accent (Purple/200) — the black-on-black repro', () => {
    // isTyping=true + agentPhase idle → showTypingIndicator → the inline
    // thinking row renders TerosLoading (mocked) with the resolved color.
    setChannel({ isChatReady: true })
    setMessages(['m1'])
    h.store.value = {
      ...h.store.value,
      channels: { [CH]: { isTyping: true, agentPhase: 'idle' } },
    }
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('teros-loading')).toBeTruthy()
    // renderWithTamagui defaults to the DARK theme: the dot must ride the
    // theme accent (Purple/200 #9C6BFF), NOT the near-black indigoDark.
    expect(h.loadingColors.value).toContain(surface.dark.accent)
    expect(h.loadingColors.value).not.toContain(semanticColors.indigoDark)
  })

  it('thinking indicator rides the light accent (Purple/300) in light', () => {
    setChannel({ isChatReady: true })
    setMessages(['m1'])
    h.store.value = {
      ...h.store.value,
      channels: { [CH]: { isTyping: true, agentPhase: 'idle' } },
    }
    render(
      <TamaguiProvider config={config} defaultTheme="light">
        <Theme name="light">
          <ChatView channelId={CH} />
        </Theme>
      </TamaguiProvider>,
    )
    expect(h.loadingColors.value).toContain(surface.light.accent)
    expect(h.loadingColors.value).not.toContain(semanticColors.indigoDark)
  })

  it('loading state spinner rides the dark accent too (not indigoDark)', () => {
    setChannel({ isLoading: true })
    const { queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByTestId('teros-loading')).toBeTruthy()
    expect(h.loadingColors.value).toContain(surface.dark.accent)
    expect(h.loadingColors.value).not.toContain(semanticColors.indigoDark)
  })
})

describe('ChatView — suggested-prompt chips visibility gate (v1.4.4)', () => {
  /** Channel with a persisted suggestion set + ≥1 message, so chips would show. */
  function setChipsChannel(overrides: Record<string, unknown> = {}) {
    setChannel({ isChatReady: true })
    setMessages(['m1'])
    h.store.value = {
      ...h.store.value,
      channels: {
        [CH]: {
          isTyping: false,
          suggestedPrompts: ['Revisa el resultado', 'Añade más detalle', 'Haz un resumen'],
          ...overrides,
        },
      },
    }
  }

  it('no turn in course → the persisted set passes through to the composer', () => {
    setChipsChannel()
    renderWithTamagui(<ChatView channelId={CH} />)
    expect(h.composerPrompts.value).toEqual([
      'Revisa el resultado',
      'Añade más detalle',
      'Haz un resumen',
    ])
  })

  it('suggestedPromptsSuppressed=true → the composer receives an EMPTY array (chips hidden)', () => {
    // The flag useChatInput sets the instant the user sends (incl. queued).
    setChipsChannel({ suggestedPromptsSuppressed: true })
    renderWithTamagui(<ChatView channelId={CH} />)
    expect(h.composerPrompts.value).toEqual([])
  })

  it('suppressed=true but NO persisted set → empty array (never resurrects anything)', () => {
    setChipsChannel({ suggestedPrompts: null, suggestedPromptsSuppressed: true })
    renderWithTamagui(<ChatView channelId={CH} />)
    expect(h.composerPrompts.value).toEqual([])
  })

  it('fresh set after the turn (channel_status cleared the flag) → new chips show', () => {
    // Post-turn state: flag cleared + new persisted set from the broadcast.
    setChipsChannel({
      suggestedPrompts: ['Nuevo prompt A', 'Nuevo prompt B'],
      suggestedPromptsSuppressed: false,
    })
    renderWithTamagui(<ChatView channelId={CH} />)
    expect(h.composerPrompts.value).toEqual(['Nuevo prompt A', 'Nuevo prompt B'])
  })
})
