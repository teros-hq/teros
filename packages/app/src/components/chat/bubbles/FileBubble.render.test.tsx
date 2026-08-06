import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { FileBubble } from './FileBubble'

/** TER-461 — render de FileBubble: nombre + tamaño formateado por rango. */
describe('FileBubble', () => {
  it('pinta el nombre del archivo y el tamaño formateado en KB', () => {
    const { getByText } = renderWithTamagui(
      <FileBubble url="https://x/doc.pdf" filename="informe.pdf" size={2048} timestamp={new Date(0)} />,
    )
    expect(getByText('informe.pdf')).toBeTruthy()
    expect(getByText('2.0 KB')).toBeTruthy() // formatSize(2048) = (2048/1024).toFixed(1)
  })

  it('formatea el tamaño por rango: B / MB', () => {
    expect(
      renderWithTamagui(
        <FileBubble url="u" filename="a.bin" size={512} timestamp={new Date(0)} />,
      ).getByText('512 B'),
    ).toBeTruthy()
    expect(
      renderWithTamagui(
        <FileBubble url="u" filename="b.bin" size={5 * 1024 * 1024} timestamp={new Date(0)} />,
      ).getByText('5.0 MB'),
    ).toBeTruthy()
  })

  it('sin size no pinta cadena de tamaño (formatSize devuelve "")', () => {
    const { queryByText } = renderWithTamagui(
      <FileBubble url="u" filename="c.txt" timestamp={new Date(0)} />,
    )
    expect(queryByText(/\b\d+(\.\d+)?\s?(B|KB|MB)\b/)).toBeNull()
  })
})
