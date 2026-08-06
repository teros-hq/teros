import { fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { EventBubble } from './EventBubble'

/**
 * TER-461 — render de EventBubble. Dos bloques:
 *
 *  1. `renderMessage` (mensaje explícito, con/sin badge de agente) — no depende de i18n.
 *  2. Ramas por `eventType` (channel_*, permission_timeout, default): se mockea
 *     `react-i18next` con un `t` determinista (`key` o `key {json-params}`) para afirmar
 *     la CLAVE y los PARÁMETROS exactos sin depender del locale, y `tilingStore` con un
 *     spy de `openWindow` para verificar la navegación al pulsar.
 *
 * Bug arreglado y blindado aquí (TER-461): `channel_started`/`channel_finished` se emiten
 * con DOS shapes según el emisor — ruta interna (`observedChannel*`, message-handler /
 * complete-my-task) y ruta MCA (`channel*`, mca-event-subscription, payload crudo del
 * topic `channel:turn_*`). El componente debe ser shape-agnostic. Antes cada rama leía un
 * solo shape: `channel_started` quedaba roto para la ruta interna (nombre vacío + sin
 * botón) y `channel_finished` tenía un segundo `if` muerto (inalcanzable) con inglés
 * hardcoded en el vivo. Los tests de "ruta interna" (started) y "ruta MCA" (finished)
 * nacen ROJOS si se revierte el fix.
 */
const h = vi.hoisted(() => {
  const openWindow = vi.fn()
  const t = vi.fn((key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
  )
  return { openWindow, t }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t }) }))
vi.mock('../../../store/tilingStore', () => ({
  useTilingStore: (selector: (s: { openWindow: typeof h.openWindow }) => unknown) =>
    selector({ openWindow: h.openWindow }),
}))

beforeEach(() => {
  h.t.mockClear()
  h.openWindow.mockClear()
})

describe('EventBubble — renderMessage', () => {
  it('inserta el nombre del agente como badge y conserva el resto del mensaje', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble
        eventType="task_update"
        eventData={{ message: 'Nira empezó la tarea', agentName: 'Nira', agentAvatar: 'http://x/a.png' }}
        timestamp={new Date(0)}
      />,
    )
    expect(getByText('Nira')).toBeTruthy() // badge del agente
    expect(getByText('empezó la tarea')).toBeTruthy() // texto tras el split por agentName
  })

  it('quita el emoji de cabecera del mensaje', () => {
    const { getByText, queryByText } = renderWithTamagui(
      <EventBubble
        eventType="system_resume"
        eventData={{ message: '🔄 Reanudando conversación' }}
        timestamp={new Date(0)}
      />,
    )
    expect(getByText('Reanudando conversación')).toBeTruthy()
    expect(queryByText(/🔄/)).toBeNull()
  })
})

describe('EventBubble — ramas por tipo de evento (i18n + shape-agnostic)', () => {
  // ---- channel_started ----------------------------------------------------
  it('channel_started (ruta interna observedChannel*): resuelve el nombre y el botón navega al canal', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble
        eventType="channel_started"
        eventData={{ observedChannelId: 'ch_int', observedChannelName: 'Tarea A' }}
        timestamp={new Date(0)}
      />,
    )
    // Antes del fix esto era undefined (leía channelId/channelName ausentes) → nace rojo si se revierte.
    expect(h.t).toHaveBeenCalledWith('conversation.events.channelStarted', { channel: 'Tarea A' })
    fireEvent.click(getByText('conversation.events.open'))
    expect(h.openWindow).toHaveBeenCalledWith('chat', { channelId: 'ch_int' }, true)
  })

  it('channel_started (ruta MCA channel*): resuelve el nombre desde channelName/channelId', () => {
    renderWithTamagui(
      <EventBubble
        eventType="channel_started"
        eventData={{ channelId: 'ch_mca', channelName: 'Worker' }}
        timestamp={new Date(0)}
      />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.channelStarted', { channel: 'Worker' })
  })

  it('channel_started: oculta el botón open sin id de canal en ningún shape', () => {
    const { queryByText } = renderWithTamagui(
      <EventBubble eventType="channel_started" eventData={{ observedChannelName: 'Sin id' }} timestamp={new Date(0)} />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.channelStarted', { channel: 'Sin id' })
    expect(queryByText('conversation.events.open')).toBeNull()
  })

  // ---- channel_finished ---------------------------------------------------
  it('channel_finished (ruta interna observedChannel*): usa i18n channelFinished y navega', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble
        eventType="channel_finished"
        eventData={{ observedChannelId: 'ch_fin', observedChannelName: 'Tarea B' }}
        timestamp={new Date(0)}
      />,
    )
    // Antes del fix el branch vivo pintaba "X finished" hardcoded → nunca llamaba channelFinished.
    expect(h.t).toHaveBeenCalledWith('conversation.events.channelFinished', { channel: 'Tarea B' })
    fireEvent.click(getByText('conversation.events.open'))
    expect(h.openWindow).toHaveBeenCalledWith('chat', { channelId: 'ch_fin' }, true)
  })

  it('channel_finished (ruta MCA channel*): resuelve nombre e id desde channel* y navega', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble
        eventType="channel_finished"
        eventData={{ channelId: 'ch_mca2', channelName: 'Sub MCA' }}
        timestamp={new Date(0)}
      />,
    )
    // Antes del fix la ruta MCA caía al branch observedChannel* (campos ausentes) → "Sub-channel
    // finished" sin botón. Ahora resuelve channel* → nace rojo si se revierte el shape-agnostic.
    expect(h.t).toHaveBeenCalledWith('conversation.events.channelFinished', { channel: 'Sub MCA' })
    fireEvent.click(getByText('conversation.events.open'))
    expect(h.openWindow).toHaveBeenCalledWith('chat', { channelId: 'ch_mca2' }, true)
  })

  // ---- channel_resolved ---------------------------------------------------
  it('channel_resolved concedido: usa approved con el shortTool y NO denied', () => {
    renderWithTamagui(
      <EventBubble
        eventType="channel_resolved"
        eventData={{ observedChannelName: 'Canal', toolName: 'gmail_send_email', resolution: 'granted' }}
        timestamp={new Date(0)}
      />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.approved', { channel: 'Canal', tool: 'email' })
    expect(h.t).not.toHaveBeenCalledWith('conversation.events.denied', { channel: 'Canal', tool: 'email' })
  })

  it('channel_resolved denegado: usa denied cuando resolution !== granted', () => {
    renderWithTamagui(
      <EventBubble
        eventType="channel_resolved"
        eventData={{ observedChannelName: 'Canal', toolName: 'fs_delete_file', resolution: 'denied' }}
        timestamp={new Date(0)}
      />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.denied', { channel: 'Canal', tool: 'file' })
    expect(h.t).not.toHaveBeenCalledWith('conversation.events.approved', { channel: 'Canal', tool: 'file' })
  })

  // ---- permission_timeout -------------------------------------------------
  it('permission_timeout: muestra el aviso de timeout y autodenied con el shortTool', () => {
    renderWithTamagui(
      <EventBubble eventType="permission_timeout" eventData={{ toolName: 'linear_create_issue' }} timestamp={new Date(0)} />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.permissionTimedOut')
    expect(h.t).toHaveBeenCalledWith('conversation.events.autodenied', { tool: 'issue' })
  })

  it('permission_timeout: el shortTool cae a "tool" sin toolName', () => {
    renderWithTamagui(<EventBubble eventType="permission_timeout" eventData={{}} timestamp={new Date(0)} />)
    expect(h.t).toHaveBeenCalledWith('conversation.events.autodenied', { tool: 'tool' })
  })

  // ---- channel_permission -------------------------------------------------
  it('channel_permission: needsApproval con el canal, tool con shortTool y navega a aprobar', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble
        eventType="channel_permission"
        eventData={{ observedChannelId: 'ch_perm', observedChannelName: 'Obs', toolName: 'slack_post_message' }}
        timestamp={new Date(0)}
      />,
    )
    expect(h.t).toHaveBeenCalledWith('conversation.events.needsApproval', { channel: 'Obs' })
    expect(h.t).toHaveBeenCalledWith('conversation.events.tool', { tool: 'message' })
    fireEvent.click(getByText('conversation.events.goToApprove'))
    expect(h.openWindow).toHaveBeenCalledWith('chat', { channelId: 'ch_perm' }, true)
  })

  // ---- default ------------------------------------------------------------
  it('tipo sin rama propia y sin message/description: cae a systemEvent', () => {
    const { getByText } = renderWithTamagui(
      <EventBubble eventType="reminder" eventData={{}} timestamp={new Date(0)} />,
    )
    expect(getByText('conversation.events.systemEvent')).toBeTruthy()
  })
})
