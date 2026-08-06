import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { ImageBubble } from './ImageBubble'

/** TER-461 — render de ImageBubble: caption visible. */
describe('ImageBubble', () => {
  it('pinta el caption cuando se pasa', () => {
    const { getByText } = renderWithTamagui(
      <ImageBubble url="https://x/img.png" caption="un gato" timestamp={new Date(0)} />,
    )
    expect(getByText('un gato')).toBeTruthy()
  })

  it('sin caption no revienta y no pinta texto de caption', () => {
    const { queryByText } = renderWithTamagui(
      <ImageBubble url="https://x/img.png" timestamp={new Date(0)} />,
    )
    expect(queryByText('un gato')).toBeNull()
  })
})
