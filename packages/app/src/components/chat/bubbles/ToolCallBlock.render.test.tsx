import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { ToolCallBlock } from './ToolCallBlock'
import type { ToolCall } from './types'

/**
 * TER-461 — ToolCallBlock es el dispatcher: resuelve el renderer por (mcaId, toolName)
 * vía McaRegistry y le reenvía el contrato COMPLETO del tool, derivando `appIcon` del
 * mcaId. Pinamos ese contrato porque ya driftó antes (un build dejó de pasar
 * attachments/appIcon/irreversible → el badge de irreversibilidad desaparecía, Renderer
 * UX v2 §8).
 *
 * Mockeamos el barrel `../../mca` (que registra eagerly todos los renderers MCA — un
 * grafo enorme Flow-typed) para cargar solo la lógica de mapeo del dispatcher y
 * mantenernos en scope de plataforma: resolver el renderer concreto es trabajo de
 * McaRegistry (cubierto en #224). El mock devuelve un renderer-espía que captura props.
 *
 * `formatToolCallText` (mismo archivo) NO se testea: sin consumidor vivo en el repo
 * (solo el barrel + bundles compilados) → dead code, registrado en TER-478.
 */
const h = vi.hoisted(() => {
  const captured: { props?: Record<string, unknown> } = {}
  const Spy = (props: Record<string, unknown>) => {
    captured.props = props
    return null
  }
  return { captured, getRenderer: vi.fn(() => Spy) }
})
vi.mock('../../mca', () => ({
  McaRegistry: { getToolCallRendererByMcpId: h.getRenderer },
}))

describe('ToolCallBlock — dispatcher', () => {
  const origBackend = process.env.EXPO_PUBLIC_BACKEND_URL
  beforeEach(() => {
    h.captured.props = undefined
    h.getRenderer.mockClear()
  })
  afterEach(() => {
    process.env.EXPO_PUBLIC_BACKEND_URL = origBackend
  })

  it('resuelve el renderer por (mcaId, toolName) y le reenvía el contrato completo con appIcon derivado', () => {
    process.env.EXPO_PUBLIC_BACKEND_URL = 'http://be.test'
    const tool: ToolCall = {
      toolCallId: 'tc_1',
      toolName: 'run',
      mcaId: 'mca.x',
      appId: 'app_1',
      input: { command: 'ls' },
      status: 'completed',
      output: 'ok',
      duration: 42,
      attachments: [{ url: 'http://a/1', mime: 'image/png' }],
      permissionRequestId: 'pr_1',
      irreversible: true,
    }
    renderWithTamagui(<ToolCallBlock tool={tool} />)

    expect(h.getRenderer).toHaveBeenCalledWith('mca.x', 'run')
    expect(h.captured.props).toEqual({
      toolCallId: 'tc_1',
      toolName: 'run',
      input: { command: 'ls' },
      status: 'completed',
      output: 'ok',
      error: undefined,
      duration: 42,
      attachments: [{ url: 'http://a/1', mime: 'image/png' }],
      appId: 'app_1',
      appIcon: 'http://be.test/static/mcas/mca.x/icon.png',
      permissionRequestId: 'pr_1',
      irreversible: true,
    })
  })

  it('deriva appIcon undefined cuando el tool no trae mcaId', () => {
    const tool: ToolCall = { toolCallId: 'tc_2', toolName: 't', status: 'running' }
    renderWithTamagui(<ToolCallBlock tool={tool} />)

    expect(h.getRenderer).toHaveBeenCalledWith(undefined, 't')
    expect(h.captured.props?.appIcon).toBeUndefined()
  })

  it('las meta-tools de descubrimiento del proxy no renderizan nada', () => {
    for (const toolName of ['list-installed-apps', 'list-app-tools']) {
      const tool: ToolCall = { toolCallId: `tc_${toolName}`, toolName, status: 'completed' }
      renderWithTamagui(<ToolCallBlock tool={tool} />)
    }

    expect(h.getRenderer).not.toHaveBeenCalled()
    expect(h.captured.props).toBeUndefined()
  })

  it('execute-tool sin tunelar (resolución fallida) sí renderiza — bloque de error genérico', () => {
    const tool: ToolCall = { toolCallId: 'tc_e', toolName: 'execute-tool', status: 'failed', error: 'boom' }
    renderWithTamagui(<ToolCallBlock tool={tool} />)

    expect(h.getRenderer).toHaveBeenCalledWith(undefined, 'execute-tool')
  })
})
