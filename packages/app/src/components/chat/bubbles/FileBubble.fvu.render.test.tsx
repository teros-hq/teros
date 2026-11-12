import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { FileBubble } from './FileBubble'

/**
 * FVU (spec v1.2.0) — the universal file bubble: strip + inline body by kind
 * + the 4 universal actions, with backward compatibility for url-only messages.
 * The old FileBubble suite (FileBubble.render.test.tsx) stays green: strip
 * name + formatted size are still rendered by the universal widget.
 */
describe('FileBubble — FVU universal widget', () => {
  afterEach(() => vi.restoreAllMocks())

  it('FVU-AC-1: live MD file fetches its content and renders the markdown body inline', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('# Título' + String.fromCharCode(10) + 'Contenido', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { getByText, findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/informe.md"
        filename="informe.md"
        mimeType="text/markdown"
        size={1024}
        filePath="/workspace/informe.md"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    // strip always present
    expect(getByText('informe.md')).toBeTruthy()
    // markdown body renders inline once the text arrives (kind=markdown)
    expect(await findByTestId('file-bubble-body-md')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('FVU-AC-1: image renders inline (URL-driven body, no fetch needed)', () => {
    const { getByText, queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/foto.png"
        filename="foto.png"
        mimeType="image/png"
        size={2048}
        timestamp={new Date(0)}
      />,
    )
    expect(getByText('foto.png')).toBeTruthy()
    expect(queryByTestId('file-bubble-body-image')).not.toBeNull()
  })

  it('FVU-AC-2 (v1.3.0): the 2 essential actions are present in the strip (download/viewer)', () => {
    const { queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/datos.csv"
        filename="datos.csv"
        mimeType="text/csv"
        size={512}
        timestamp={new Date(0)}
      />,
    )
    expect(queryByTestId('file-bubble-actions-download')).not.toBeNull()
    expect(queryByTestId('file-bubble-actions-viewer')).not.toBeNull()
    // v1.3.0: fullscreen/share moved OUT of the chat strip - they live in
    // the viewer window (Pablo: the 4-button row overloaded the strip)
    expect(queryByTestId('file-bubble-actions-fullscreen')).toBeNull()
    expect(queryByTestId('file-bubble-actions-share')).toBeNull()
  })

  it('FVU-AC-2: fallback type (zip) renders the fallback body — never fails by type', () => {
    // name appears twice by design: strip + fallback body card
    const { getAllByText, queryByTestId } = renderWithTamagui(
      <FileBubble url="https://x/backup.zip" filename="backup.zip" size={4096} timestamp={new Date(0)} />,
    )
    expect(getAllByText('backup.zip').length).toBeGreaterThanOrEqual(1)
    expect(queryByTestId('file-bubble-body-fallback')).not.toBeNull()
  })

  it('FVU-AC-3: PDF renders inline (embedded viewer, no chat exit)', () => {
    const { queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/doc.pdf"
        filename="doc.pdf"
        mimeType="application/pdf"
        size={1024 * 1024}
        timestamp={new Date(0)}
      />,
    )
    expect(queryByTestId('file-bubble-body-pdf')).not.toBeNull()
  })

  it('FVU-AC-1/AC-7: CSV renders as a table inline', async () => {
    const fetchMock = vi.fn(async () => new Response('nombre,valor\nalfa,1', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/datos.csv"
        filename="datos.csv"
        mimeType="text/csv"
        size={64}
        filePath="/workspace/datos.csv"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    expect(await findByTestId('file-bubble-body-csv')).toBeTruthy()
  })

  it('FVU-AC-1/AC-7: JSON renders with syntax highlight inline', async () => {
    const fetchMock = vi.fn(async () => new Response('{"clave": "valor"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/config.json"
        filename="config.json"
        mimeType="application/json"
        size={32}
        filePath="/workspace/config.json"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    expect(await findByTestId('file-bubble-body-json')).toBeTruthy()
  })

  it('backward compat: url-only message (no mimeType/size) still renders the strip', () => {
    // unknown type → fallback body also shows the name (strip + body)
    const { getAllByText } = renderWithTamagui(
      <FileBubble url="u" filename="legacy.bin" timestamp={new Date(0)} />,
    )
    expect(getAllByText('legacy.bin').length).toBeGreaterThanOrEqual(1)
  })
})
