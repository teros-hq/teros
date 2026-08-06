import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'

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
  usePermissionGroups: () => ({ groupedRequestIds: new Set(), groupByAnchorId: new Map() }),
}))
vi.mock('../../hooks/chat/useChatScroll', () => ({
  useChatScroll: () => ({ flatListRef: { current: null }, scrollToBottom: vi.fn() }),
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
vi.mock('../../store/featureFlagsStore', () => ({
  useFeatureFlagsStore: { getState: () => ({}) },
  getResolvedFlag: () => false, // voice.enabled = false
}))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ channel: { stopMessage: vi.fn(), transcribeAudio: vi.fn() } }),
}))

// --- i18n determinista -----------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

// --- componentes pesados: no-ops (con testid donde hace falta) -------------
vi.mock('../TerosLoading', async () => {
  const React = await import('react')
  return { TerosLoading: () => React.createElement('div', { 'data-testid': 'teros-loading' }) }
})
vi.mock('../InputComposer', async () => {
  const React = await import('react')
  return { InputComposer: () => React.createElement('div', { 'data-testid': 'input-composer' }) }
})
vi.mock('../MessageItem', () => ({ MessageItem: () => null }))
vi.mock('./ChatHeader', () => ({ ChatHeader: () => null }))
vi.mock('../Avatar', () => ({ Avatar: () => null }))
vi.mock('../voice/TranscriptDisplay', () => ({ TranscriptDisplay: () => null }))
vi.mock('../voice/VoiceControls', () => ({ VoiceControls: () => null }))
vi.mock('../mca', () => ({ PermissionContext: { Provider: ({ children }: { children: unknown }) => children } }))
vi.mock('../mca/primitives/GroupedPermissionPanel', () => ({ GroupedPermissionPanel: () => null }))
vi.mock('../mca/primitives/PermissionGroupContext', () => ({
  PermissionGroupContext: { Provider: ({ children }: { children: unknown }) => children },
}))

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

  it('empty: canal listo y sin mensajes → startConversation + composer (sin spinner)', () => {
    setChannel({ isChatReady: true })
    setMessages([])
    const { getByText, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(getByText('conversation.startConversation')).toBeTruthy()
    expect(queryByTestId('input-composer')).toBeTruthy() // ya en la vista principal
    expect(queryByTestId('teros-loading')).toBeNull() // isChatReady=true → sin overlay
  })

  it('no-empty: canal listo con mensajes → sin startConversation (renderiza la lista)', () => {
    setChannel({ isChatReady: true })
    setMessages(['m1'])
    const { queryByText, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByText('conversation.startConversation')).toBeNull()
    expect(queryByTestId('input-composer')).toBeTruthy()
  })

  it('empty requiere isChatReady: no-listo y sin mensajes → NO startConversation, sí overlay', () => {
    setChannel({ isChatReady: false })
    setMessages([])
    const { queryByText, queryByTestId } = renderWithTamagui(<ChatView channelId={CH} />)
    expect(queryByText('conversation.startConversation')).toBeNull() // el guard isChatReady evita el empty
    expect(queryByTestId('teros-loading')).toBeTruthy() // overlay !isChatReady
    expect(queryByTestId('input-composer')).toBeTruthy() // ya en vista principal
  })
})
