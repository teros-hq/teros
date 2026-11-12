import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { FileBubble } from './FileBubble'

/** TER-461 — render de FileBubble: nombre + tamaño formateado por rango. */
describe('FileBubble', () => {
  it('pinta el nombre del archivo y el tamaño formateado en KB', () => {
    const { getAllByText } = renderWithTamagui(
      <FileBubble url="https://x/doc.pdf" filename="informe.pdf" size={2048} timestamp={new Date(0)} />,
    )
    // FVU: name renders in the strip + fallback body (pdf → fallback kind)
    expect(getAllByText('informe.pdf').length).toBeGreaterThanOrEqual(1)
    // FVU meta line: "size · subtype" (formatFileSize(2048) = "2.0 KB")
    expect(getAllByText('2.0 KB · PDF').length).toBeGreaterThanOrEqual(1)
  })

  it('formatea el tamaño por rango: B / MB', () => {
    expect(
      renderWithTamagui(
        <FileBubble url="u" filename="a.bin" size={512} timestamp={new Date(0)} />,
      ).getAllByText('512 B · BIN').length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      renderWithTamagui(
        <FileBubble url="u" filename="b.bin" size={5 * 1024 * 1024} timestamp={new Date(0)} />,
      ).getAllByText('5.0 MB · BIN').length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('sin size no pinta cadena de tamaño (formatSize devuelve "")', () => {
    const { queryByText } = renderWithTamagui(
      <FileBubble url="u" filename="c.txt" timestamp={new Date(0)} />,
    )
    expect(queryByText(/\b\d+(\.\d+)?\s?(B|KB|MB)\b/)).toBeNull()
  })
})
