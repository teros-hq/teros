import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { renderHtmlSpy } from '../../../test/reactNativeRenderHtmlStub'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { MarkdownContent, PreRenderer } from './MarkdownContent'

/**
 * TER-461 — MarkdownContent:
 *  - PreRenderer.extractText: recorre recursivamente el árbol de nodos para sacar el
 *    texto plano del <pre> (lógica propia, no de la lib).
 *  - El componente parsea el markdown con `marked` y pasa el HTML resultante a
 *    RenderHtml. RenderHtml está stubbeado (lib Flow-typed) y captura su `source`,
 *    así verificamos el cableado marked→HTML sin renderizar HTML real.
 */
describe('PreRenderer — extractText', () => {
  it('concatena el texto de un árbol de nodos anidado', () => {
    const tnode = {
      domNode: {
        children: [
          { type: 'text', data: 'const ' },
          { children: [{ type: 'text', data: 'x = 1' }] },
        ],
      },
    }
    const { container } = renderWithTamagui(<PreRenderer tnode={tnode} />)
    expect(container.querySelector('code')?.textContent).toBe('const x = 1')
  })

  it('devuelve cadena vacía para un nodo sin texto ni hijos', () => {
    const { container } = renderWithTamagui(<PreRenderer tnode={{ domNode: { type: 'tag' } }} />)
    expect(container.querySelector('code')?.textContent).toBe('')
  })
})

describe('MarkdownContent — cableado marked → RenderHtml', () => {
  it('parsea el markdown a HTML y se lo pasa a RenderHtml', () => {
    renderWithTamagui(<MarkdownContent text="**hola**" />)
    expect(renderHtmlSpy.source?.html).toBe(marked.parse('**hola**'))
    expect(renderHtmlSpy.source?.html).toContain('<strong>') // HTML real, no markdown crudo
  })
})
