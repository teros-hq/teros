import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { FileBubble } from './FileBubble'
import { HtmlFileBubble } from './HtmlBubble'

// Deterministic viewport: react-native-web's Dimensions caches the initial
// window size and its resize listener is not reliably wired in jsdom, so we
// mock useWindowDimensions directly. This is the ONLY reliable way to test
// the narrow/wide branch of the v1.3.3 adaptive width.
let mockWidth = 390
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    useWindowDimensions: () => ({ width: mockWidth, height: 844, scale: 2, fontScale: 1 }),
  }
})

/**
 * FVU v1.3.3 — mobile viewport regression tests (Pablo's feedback 2026-10-16).
 *
 * The v1.3.0 adaptive width (min(85%, 680px) + width 100%) was never covered
 * by a narrow-viewport test: jsdom defaults to 1024px, so every render test
 * ran in "desktop" mode. These tests mock useWindowDimensions to 390px
 * (iPhone 12 class) and pin the two layout rules the feedback demands:
 *
 *  1. NO bubble may exceed the window width — bodies scroll internally.
 *  2. Symmetric margins: on narrow screens the bubble fills 100% of the
 *     available width (maxWidth "100%"), so L=R margins come from the chat
 *     padding — the 85% cap only applies on wide screens.
 */

// The wide markdown table that triggered Bug 1: intrinsic width far beyond
// 390px. If the body container does not clamp (overflow hidden + minWidth 0),
// it stretches the bubble past the screen edge and the strip actions become
// unreachable.
const WIDE_TABLE_MD =
  '# Informe\n\n' +
  '| Categoria | Etiquetas | Precision | Cobertura | Notas del evaluador | Tendencia | Siguiente accion | Responsable | Estado | Prioridad |\n' +
  '|---|---|---|---|---|---|---|---|---|---|\n' +
  '| Producto | 1204 | 94,2% | 87,5% | Muy buena consistencia en categorias padre | +12% | Ampliar a subcategorias de nivel 3 | Equipo tagging | Activo | P1 |\n' +
  '| Soporte | 856 | 91,8% | 82,1% | Ambiguedades en tickets reabiertos | +8% | Guia de decision | Equipo tagging | Activo | P2 |\n'

const WIDE_TABLE_HTML =
  '<table><tr>' +
  Array.from({ length: 12 }, (_, i) => `<th>Col ${i}</th>`).join('') +
  '</tr><tr>' +
  Array.from({ length: 12 }, (_, i) => `<td>Valor largo de ejemplo ${i}</td>`).join('') +
  '</tr></table>'

function mockViewport(width: number) {
  mockWidth = width
}

/** Tamagui compiles props to atomic CSS classes (_maw-10037 etc.), not
 *  inline styles — so assertions must go through getComputedStyle, which
 *  resolves the class rules in jsdom. */
function styleOf(el: HTMLElement | null): Record<string, string> {
  if (!el) return {}
  const cs = getComputedStyle(el)
  return {
    'max-width': cs.maxWidth,
    'min-width': cs.minWidth,
    'align-self': cs.alignSelf,
    // react-native-web's View maps overflow to overflow-x/overflow-y —
    // cs.overflow stays '' in jsdom even when both are set inline.
    overflow: cs.overflow || `${el.style.overflowX} ${el.style.overflowY}`.trim(),
    width: cs.width,
  }
}

describe('FileBubble — mobile viewport (v1.3.3 regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    cleanup()
  })

  it('MOBILE-1: narrow viewport (390px) — bubble root is maxWidth 100%, minWidth 0 (fills width, symmetric margins)', () => {
    mockViewport(390)
    const { getByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/informe.md"
        filename="informe.md"
        mimeType="text/markdown"
        size={1024}
        timestamp={new Date(0)}
      />,
    )
    const root = getByTestId('file-bubble')
    const style = styleOf(root)
    // v1.3.3: on narrow screens the cap is GONE — the bubble fills the
    // available width so the margins are the chat padding, L = R.
    expect(style['max-width']).toBe('100%')
    expect(style['min-width']).toBe('0px')
  })

  it('MOBILE-2: narrow viewport — the card stretches to the bubble width (no fit-content escape hatch for wide tables)', () => {
    mockViewport(390)
    const { getByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/informe.md"
        filename="informe.md"
        mimeType="text/markdown"
        size={1024}
        timestamp={new Date(0)}
      />,
    )
    const card = getByTestId('file-bubble-card')
    const style = styleOf(card)
    // v1.3.0 regression: the card had minWidth 240 but no stretch — a wide
    // table made fit-content blow past the parent's maxWidth. v1.3.3 pins
    // stretch + minWidth 0.
    expect(style['align-self']).toBe('stretch')
    expect(style['min-width']).toBe('0px')
  })

  it('MOBILE-3: narrow viewport — markdown body clamps overflow (tables scroll INSIDE, never stretch the bubble)', async () => {
    const fetchMock = vi.fn(async () => new Response(WIDE_TABLE_MD, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mockViewport(390)
    const { findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/informe.md"
        filename="informe.md"
        mimeType="text/markdown"
        size={2048}
        filePath="/workspace/informe.md"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    const body = await findByTestId('file-bubble-body-md')
    const style = styleOf(body)
    // The body container must clamp: overflow hidden + minWidth 0. Without
    // it, the wide table's intrinsic width propagates up and the bubble
    // overflows the window (Bug 1 — actions unreachable).
    expect(style['overflow']).toContain('hidden')
    expect(style['min-width']).toBe('0px')
  })

  it('MOBILE-4: wide viewport (1200px) — the 85%/680px cap still applies (desktop unchanged)', () => {
    mockViewport(1200)
    const { getByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/informe.md"
        filename="informe.md"
        mimeType="text/markdown"
        size={1024}
        timestamp={new Date(0)}
      />,
    )
    const root = getByTestId('file-bubble')
    const style = styleOf(root)
    expect(style['max-width']).toBe('680px')
  })

  it('MOBILE-5: strip actions stay inside the window on narrow viewport (reachable)', () => {
    mockViewport(390)
    const { getByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/datos.csv"
        filename="datos.csv"
        mimeType="text/csv"
        size={512}
        timestamp={new Date(0)}
      />,
    )
    const download = getByTestId('file-bubble-actions-download')
    const viewer = getByTestId('file-bubble-actions-viewer')
    // Reachable = rendered and within the viewport horizontally.
    const rect = download.getBoundingClientRect()
    const rect2 = viewer.getBoundingClientRect()
    expect(rect.right).toBeLessThanOrEqual(390)
    expect(rect2.right).toBeLessThanOrEqual(390)
  })
})

describe('HtmlFileBubble — mobile viewport (v1.3.3 regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    cleanup()
  })

  it('MOBILE-6: narrow viewport — html bubble fills 100% width (symmetric L=R margins, Bug 2)', async () => {
    const fetchMock = vi.fn(async () => new Response(WIDE_TABLE_HTML, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mockViewport(390)
    const { container } = renderWithTamagui(
      <HtmlFileBubble
        filePath="/workspace/informe.html"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    // The outer YStack wrapper: maxWidth 100% + minWidth 0 on narrow screens.
    // (The layout is computed at render time — no need to wait for the fetch.
    // The component renders a Fragment; its root is a <span display:contents>
    // pass-through, so descend to the first styled element inside it.)
    const wrapper = (container.querySelector('span > div') ?? container.firstElementChild) as HTMLElement
    const style = styleOf(wrapper)
    expect(style['max-width']).toBe('100%')
    expect(style['min-width']).toBe('0px')
  })

  it('MOBILE-7: wide viewport — html bubble keeps the 700px cap (desktop unchanged)', async () => {
    const fetchMock = vi.fn(async () => new Response(WIDE_TABLE_HTML, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mockViewport(1200)
    const { container } = renderWithTamagui(
      <HtmlFileBubble
        filePath="/workspace/informe.html"
        workspaceId="ws_1"
        channelId="ch_1"
        timestamp={new Date(0)}
      />,
    )
    const wrapper = (container.querySelector('span > div') ?? container.firstElementChild) as HTMLElement
    const style = styleOf(wrapper)
    expect(style['max-width']).toBe('700px')
  })
})

describe('FileBubble — v1.3.4 feedback fixes', () => {
  afterEach(cleanup)

  it('V134-1: .html file fetches its text — the inline body iframe renders (not just the strip)', async () => {
    mockViewport(390)
    const fetchMock = vi.fn(async () => new Response('<h1>Hola</h1>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/i.html"
        filename="i.html"
        mimeType="text/html"
        size={512}
        filePath="/w/i.html"
        workspaceId="ws"
        channelId="ch"
        timestamp={new Date(0)}
      />,
    )
    // The body iframe only renders when textContent arrived — Pablo saw
    // "solo el header" because html was excluded from the text pipeline.
    const body = await findByTestId('file-bubble-body-html')
    expect(body).toBeTruthy()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('V134-2: fallback kind (zip) renders NO strip — only the body with integrated download', async () => {
    mockViewport(390)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/i.zip"
        filename="i.zip"
        mimeType="application/zip"
        size={276}
        timestamp={new Date(0)}
      />,
    )
    // The strip is gone for fallback kinds (Pablo: header redundante)...
    // v1.3.6: assert on the strip's OWN testID — the old assertion on
    // 'file-bubble-actions' was vacuous (UFA only emits -row/-download/
    // -viewer suffixed IDs, so that query could never find anything).
    expect(queryByTestId('file-bubble-strip')).toBeNull()
    expect(queryByTestId('file-bubble-actions-row')).toBeNull()
    // ...and the download now lives in the body icon tile.
    const dl = getByTestId('file-bubble-body-fallback-download')
    expect(dl).toBeTruthy()
    const body = getByTestId('file-bubble-body-fallback')
    const r = body.getBoundingClientRect()
    expect(r.right <= 390).toBe(true)
  })

  it('V134-3: JSON body uses the theme-aware highlighter (oneLight in light mode)', async () => {
    mockViewport(390)
    const fetchMock = vi.fn(async () => new Response('{"a": 1}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { findByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/i.json"
        filename="i.json"
        mimeType="application/json"
        size={248}
        timestamp={new Date(0)}
      />,
    )
    const body = await findByTestId('file-bubble-body-json')
    expect(body).toBeTruthy()
    // The SyntaxHighlighter renders a <pre> — present means the highlight
    // path executed (vs the invalid-JSON plain text path).
    expect(body.querySelector('pre')).toBeTruthy()
  })


  it('V139-1: pdf on narrow viewport (390px) renders strip + inline iframe — same pattern as desktop (v1.3.9 removed the mobile special case)', async () => {
    mockViewport(390)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/i.pdf"
        filename="i.pdf"
        mimeType="application/pdf"
        size={312000}
        timestamp={new Date(0)}
      />,
    )
    // v1.3.9: the "mobile browsers don't render PDF iframes" diagnosis was
    // contaminated by the X-Frame-Options bug — Pablo verified on iPhone
    // (landscape) that the inline iframe renders fine. One pattern at every
    // width now: strip + inline iframe.
    expect(getByTestId('file-bubble-strip')).toBeTruthy()
    expect(getByTestId('file-bubble-actions-row')).toBeTruthy()
    // v1.3.8 single action: Abrir (new tab) — the native viewer that opens
    // carries the real download button itself.
    expect(getByTestId('file-bubble-actions-newtab')).toBeTruthy()
    expect(queryByTestId('file-bubble-actions-download')).toBeNull()
    // No fallback row — the iframe renders instead.
    expect(queryByTestId('file-bubble-body-pdf-download')).toBeNull()
    const body = getByTestId('file-bubble-body-pdf')
    expect(body.querySelector('iframe')).toBeTruthy()
    const r = body.getBoundingClientRect()
    expect(r.right <= 390).toBe(true)
  })

  it('V136-2: pdf on desktop (1200px) KEEPS the strip + inline iframe (no regression)', async () => {
    mockViewport(1200)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <FileBubble
        url="https://x/i.pdf"
        filename="i.pdf"
        mimeType="application/pdf"
        size={312000}
        timestamp={new Date(0)}
      />,
    )
    // Desktop keeps the standard pattern: strip with actions + inline embed.
    // (UniversalFileActions appends -row to the testID it receives.)
    expect(getByTestId('file-bubble-strip')).toBeTruthy()
    expect(getByTestId('file-bubble-actions-row')).toBeTruthy()
    // v1.3.8: PDF bubble = single Abrir (new tab) action — the native
    // viewer that opens carries the real download button itself (Pablo).
    expect(queryByTestId('file-bubble-actions-download')).toBeNull()
    expect(queryByTestId('file-bubble-actions-viewer')).toBeNull()
    expect(getByTestId('file-bubble-actions-newtab')).toBeTruthy()
    // No fallback row on desktop — the iframe renders instead.
    expect(queryByTestId('file-bubble-body-pdf-download')).toBeNull()
    const body = getByTestId('file-bubble-body-pdf')
    expect(body.querySelector('iframe')).toBeTruthy()
  })
})
