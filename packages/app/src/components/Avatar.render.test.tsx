import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../test/renderWithTamagui'
import { Avatar } from './Avatar'

/**
 * TER-606 — el fallback a iniciales debe activarse también cuando la imagen
 * EXISTE pero falla al cargar (404, URL rota), no solo cuando imageUrl es falsy.
 * Sin onError el navegador pintaba el glifo de imagen rota.
 */
describe('Avatar', () => {
  it('renderiza la imagen cuando hay imageUrl válida', () => {
    const { container } = renderWithTamagui(
      <Avatar name="Iria Vega" imageUrl="https://x/iria-avatar.jpg" />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe('https://x/iria-avatar.jpg')
  })

  it('cae a iniciales cuando la imagen falla al cargar (onError)', () => {
    const { container, getByText, queryByText } = renderWithTamagui(
      <Avatar name="Iria Vega" imageUrl="https://x/broken.jpg" />,
    )
    // Antes del fallo: imagen presente, sin iniciales.
    expect(queryByText('IV')).toBeNull()
    const img = container.querySelector('img')
    expect(img).toBeTruthy()

    fireEvent.error(img as HTMLImageElement)

    // Tras el fallo: iniciales (primera + última palabra), sin <img> roto.
    expect(getByText('IV')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('muestra iniciales directamente cuando no hay imageUrl', () => {
    const { container, getByText } = renderWithTamagui(<Avatar name="Iria Vega" />)
    expect(getByText('IV')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })
})
