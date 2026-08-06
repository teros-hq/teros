import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { HtmlBubble } from './HtmlBubble'

/**
 * TER-461 — render + seguridad de HtmlBubble.
 *
 * HtmlBubble renderiza HTML/CSS de un mensaje (contenido NO confiable, generado
 * por agentes/LLM) dentro de un <iframe srcDoc> con `sandbox="allow-scripts"`.
 * El aislamiento por iframe sandbox es la mitigación: `allow-scripts` SIN
 * `allow-same-origin` deja correr scripts en un origen opaco, sin acceso al DOM /
 * cookies / storage del documento padre → no puede hacer XSS contra la app.
 * Estos tests blindan ese invariante: una mutación que añada `allow-same-origin`
 * (escape del sandbox) o quite el sandbox los pone en rojo.
 */
describe('HtmlBubble — aislamiento del HTML no confiable', () => {
  const MALICIOUS =
    '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>'

  it('mete el HTML del mensaje en el srcdoc del iframe, nunca en el documento padre', () => {
    const { container } = renderWithTamagui(
      <HtmlBubble html={MALICIOUS} timestamp={new Date(0)} />,
    )
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    // El HTML va dentro del srcdoc del iframe (sandbox), aislado.
    expect(iframe?.getAttribute('srcdoc')).toContain('onerror')
    // El documento padre NO contiene el nodo malicioso vivo.
    expect(container.querySelector('img[onerror]')).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('TODO iframe lleva sandbox="allow-scripts" sin allow-same-origin (no escape)', () => {
    const { container } = renderWithTamagui(
      <HtmlBubble html="<p>hola</p>" timestamp={new Date(0)} />,
    )
    const iframes = container.querySelectorAll('iframe')
    expect(iframes.length).toBeGreaterThan(0)
    Array.from(iframes).forEach((f) => {
      const sandbox = f.getAttribute('sandbox')
      expect(sandbox).toBe('allow-scripts')
      expect(sandbox).not.toContain('allow-same-origin')
    })
  })
})
