import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { UniversalFileActions } from './UniversalFileActions'

/**
 * FVU v1.3.0 (FVU-REQ-2) — the context variants of the action row:
 *  - bubble: ONLY the 2 essential actions (Descargar · Abrir en FileViewer)
 *  - window/overlay: the full set, icon-only (Descargar · Pantalla completa ·
 *    Compartir · Refrescar — the FileViewer slot is taken by Refresh).
 */
describe('UniversalFileActions — v1.3.0 context variants', () => {
  afterEach(() => vi.restoreAllMocks())

  it('bubble variant renders ONLY the 2 essential actions', () => {
    const { queryByTestId } = renderWithTamagui(
      <UniversalFileActions
        url="https://x/f.md"
        kind="markdown"
        variant="bubble"
        onOpenViewer={() => {}}
        testID="ufa-b"
      />,
    )
    expect(queryByTestId('ufa-b-download')).not.toBeNull()
    expect(queryByTestId('ufa-b-viewer')).not.toBeNull()
    expect(queryByTestId('ufa-b-fullscreen')).toBeNull()
    expect(queryByTestId('ufa-b-share')).toBeNull()
    expect(queryByTestId('ufa-b-refresh')).toBeNull()
  })

  it('v1.3.8: pdf bubble renders ONE action — Abrir (new tab), no download/viewer', () => {
    const { getByTestId, queryByTestId, container } = renderWithTamagui(
      <UniversalFileActions url="https://x/doc.pdf" kind="pdf" testID="ufa-pdf" />,
    )
    expect(getByTestId('ufa-pdf-newtab')).not.toBeNull()
    expect(queryByTestId('ufa-pdf-download')).toBeNull()
    expect(queryByTestId('ufa-pdf-viewer')).toBeNull()
    // the surviving button carries the arrow-square-out icon (ex-export icon)
    expect(container.querySelector('.ph-arrow-square-out')).not.toBeNull()
    expect(container.querySelector('.ph-download-simple')).toBeNull()
  })

  it('window variant renders the full set icon-only (download/fullscreen/share/refresh)', () => {
    const { queryByTestId } = renderWithTamagui(
      <UniversalFileActions
        url="https://x/f.md"
        kind="markdown"
        variant="window"
        onFullscreen={() => {}}
        onRefresh={() => {}}
        testID="ufa-w"
      />,
    )
    expect(queryByTestId('ufa-w-download')).not.toBeNull()
    expect(queryByTestId('ufa-w-fullscreen')).not.toBeNull()
    expect(queryByTestId('ufa-w-share')).not.toBeNull()
    expect(queryByTestId('ufa-w-refresh')).not.toBeNull()
    // the FileViewer action is absent — you are already in the viewer
    expect(queryByTestId('ufa-w-viewer')).toBeNull()
  })

  it('overlay variant mirrors the window set', () => {
    const { queryByTestId } = renderWithTamagui(
      <UniversalFileActions
        url="https://x/f.md"
        kind="image"
        variant="overlay"
        onFullscreen={() => {}}
        onRefresh={() => {}}
        testID="ufa-o"
      />,
    )
    expect(queryByTestId('ufa-o-download')).not.toBeNull()
    expect(queryByTestId('ufa-o-fullscreen')).not.toBeNull()
    expect(queryByTestId('ufa-o-share')).not.toBeNull()
    expect(queryByTestId('ufa-o-refresh')).not.toBeNull()
    expect(queryByTestId('ufa-o-viewer')).toBeNull()
  })

  it('default variant is bubble (2 essential actions, backward compat)', () => {
    const { queryByTestId } = renderWithTamagui(
      <UniversalFileActions url="https://x/f.md" kind="text" testID="ufa-d" />,
    )
    expect(queryByTestId('ufa-d-download')).not.toBeNull()
    expect(queryByTestId('ufa-d-viewer')).not.toBeNull()
    expect(queryByTestId('ufa-d-fullscreen')).toBeNull()
  })
})
