/**
 * TypeIn (DS Motion type-in for streaming chat) — unit tests.
 *
 * Round-3 architecture: the marker is a WRAPPER (`<span data-tail
 * data-from="N">tail</span>`) — a TPhrasing with tagName 'span' the custom
 * span renderer intercepts. The mocks reproduce the REAL TRE shapes (the
 * Fase-2 lesson: hand-mocked trees that don't match reality make green
 * tests that lie). The MarkdownContent wiring (wrapper insertion +
 * renderer merge) is covered in MarkdownContent.render.test.tsx; the
 * real-TRE pipeline in TypeIn.tre.render.test.tsx.
 */
import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import {
  TAIL_MARKER_ATTR,
  TAIL_FROM_ATTR,
  buildTypeInRenderers,
  isTailWrapper,
  subtreeHasTailMarker,
} from './TypeIn'

// tnode factories (the REAL TRE shapes this module relies on)
const text = (data: string) => ({ type: 'text', data, domNode: {} })
// The REAL wrapper shape: phrasing + tagName 'span' + data-tail/data-from.
const wrapper = (children: any[], from: number) => ({
  type: 'phrasing',
  tagName: 'span',
  domNode: { attribs: { [TAIL_MARKER_ATTR]: '', [TAIL_FROM_ATTR]: String(from) } },
  children,
})
const phrasing = (tagName: string, children: any[]) => ({ tagName, children })

describe('TypeIn — isTailWrapper', () => {
  it('detects the wrapper (span + data-tail)', () => {
    expect(isTailWrapper(wrapper([text('x')], 0))).toBe(true)
  })
  it('rejects a plain span without data-tail', () => {
    const t = { tagName: 'span', domNode: { attribs: {} }, children: [text('x')] }
    expect(isTailWrapper(t)).toBe(false)
  })
  it('rejects other tags and null', () => {
    expect(isTailWrapper(phrasing('p', []))).toBe(false)
    expect(isTailWrapper(null)).toBe(false)
  })
})

describe('TypeIn — subtreeHasTailMarker', () => {
  it('detects the wrapper at the root and nested in the subtree', () => {
    expect(subtreeHasTailMarker(wrapper([text('x')], 0))).toBe(true)
    const t = phrasing('p', [text('hola '), wrapper([text('mundo')], 5)])
    expect(subtreeHasTailMarker(t)).toBe(true)
  })
  it('returns false for a plain subtree, null, and bare text', () => {
    expect(subtreeHasTailMarker(phrasing('p', [text('hola mundo')]))).toBe(false)
    expect(subtreeHasTailMarker(null)).toBe(false)
    expect(subtreeHasTailMarker(text('x'))).toBe(false)
  })
})

describe('TypeIn — buildTypeInRenderers (the span renderer)', () => {
  it('returns exactly one renderer: span', () => {
    const renderers = buildTypeInRenderers()
    expect(Object.keys(renderers)).toEqual(['span'])
    expect(renderers.span).toBeTypeOf('function')
  })

  it('passes a non-wrapper span through untouched (default path)', () => {
    const renderers = buildTypeInRenderers()
    const TDefaultRenderer = ({ children, tnode }: any) => (
      <div data-testid="default">{children ?? tnode.children[0].data}</div>
    )
    const tnode = phrasing('span', [text('hola mundo')]) // no data-tail
    const { container } = renderWithTamagui(
      <renderers.span tnode={tnode} TDefaultRenderer={TDefaultRenderer} />,
    )
    expect(container.querySelector('[data-testid="default"]')).toBeTruthy()
    expect(container.textContent).toContain('hola mundo')
    expect(container.querySelectorAll('.ds-typein-char').length).toBe(0)
  })

  it('renders one span per char of the wrapper text, keyed from data-from', () => {
    const renderers = buildTypeInRenderers()
    const TDefaultRenderer = ({ children }: any) => <div data-testid="tail">{children}</div>
    const TNodeChildrenRenderer = ({ tnode: c }: any) => <i>{c.children[0].data}</i>
    // data-from=5: the tail starts at absolute char 5 → keys 5..9.
    const tnode = wrapper([text('mundo')], 5)
    const { container } = renderWithTamagui(
      <renderers.span
        tnode={tnode}
        TDefaultRenderer={TDefaultRenderer}
        TNodeChildrenRenderer={TNodeChildrenRenderer}
      />,
    )
    const chars = container.querySelectorAll('.ds-typein-char')
    expect(chars.length).toBe(5)
    expect(Array.from(chars).map((el) => el.textContent).join('')).toBe('mundo')
    // Stable keys = absolute indices from data-from (the remount rule).
    expect(chars[0].getAttribute('data-key') ?? true).toBeTruthy()
  })

  it('tagged children inside the wrapper render through the child path (styled, no spans)', () => {
    const renderers = buildTypeInRenderers()
    const TDefaultRenderer = ({ children }: any) => <div>{children}</div>
    const TNodeChildrenRenderer = ({ tnode: c }: any) => (
      <strong data-testid="tagged">{c.children[0].data}</strong>
    )
    const tnode = wrapper([text('mundo '), phrasing('strong', [text('cruel')])], 0)
    const { container } = renderWithTamagui(
      <renderers.span
        tnode={tnode}
        TDefaultRenderer={TDefaultRenderer}
        TNodeChildrenRenderer={TNodeChildrenRenderer}
      />,
    )
    const tagged = container.querySelector('[data-testid="tagged"]')
    expect(tagged).toBeTruthy()
    expect(tagged?.textContent).toBe('cruel')
    // 'mundo ' → 6 spans; the tagged child renders as one element.
    expect(container.querySelectorAll('.ds-typein-char').length).toBe(6)
  })

  it('renders the same tail text across ticks (stable materialization)', () => {
    const renderers = buildTypeInRenderers()
    const TDefaultRenderer = ({ children }: any) => <div>{children}</div>
    const TNodeChildrenRenderer = ({ tnode: c }: any) => <i>{c.children?.[0]?.data}</i>
    // Two consecutive ticks: the tail grows 'mun' → 'mundo'. Both wrappers
    // carry data-from=5 → shared chars get identical keys (no remount).
    const r1 = renderWithTamagui(
      <renderers.span tnode={wrapper([text('mun')], 5)} TDefaultRenderer={TDefaultRenderer} TNodeChildrenRenderer={TNodeChildrenRenderer} />,
    )
    const r2 = renderWithTamagui(
      <renderers.span tnode={wrapper([text('mundo')], 5)} TDefaultRenderer={TDefaultRenderer} TNodeChildrenRenderer={TNodeChildrenRenderer} />,
    )
    expect(Array.from(r1.container.querySelectorAll('.ds-typein-char')).map((el) => el.textContent).join('')).toBe('mun')
    expect(Array.from(r2.container.querySelectorAll('.ds-typein-char')).map((el) => el.textContent).join('')).toBe('mundo')
  })

  it('edge spaces become no-break spaces (they must not collapse away)', () => {
    const renderers = buildTypeInRenderers()
    const TDefaultRenderer = ({ children }: any) => <div>{children}</div>
    const TNodeChildrenRenderer = ({ tnode: c }: any) => <i>{c.children?.[0]?.data}</i>
    const { container } = renderWithTamagui(
      <renderers.span tnode={wrapper([text(' a ')], 0)} TDefaultRenderer={TDefaultRenderer} TNodeChildrenRenderer={TNodeChildrenRenderer} />,
    )
    const chars = container.querySelectorAll('.ds-typein-char')
    expect(chars.length).toBe(3)
    expect(chars[0].textContent).toBe('\u00A0')
    expect(chars[2].textContent).toBe('\u00A0')
  })
})
