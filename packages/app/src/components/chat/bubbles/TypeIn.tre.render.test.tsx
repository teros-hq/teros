/**
 * TypeIn × REAL transient-render-engine — the integration test that was
 * missing (and would have caught the Fase-2 bug on day one).
 *
 * The render tests stub react-native-render-html, so the marker detection
 * only ever ran against hand-mocked tnodes — which modeled the marker as a
 * 'phrasing' node. The REAL TRE materializes `<span data-tail>` as a node
 * with type 'text' AND tagName 'span', so the old detection (type check
 * before the attribs check) discarded it and the effect never fired. Pablo
 * saw plain text in the live app while every test was green.
 *
 * These tests run marked + the real @native-html/transient-render-engine
 * (CommonJS build — no React, no jsdom) and assert on the TNode tree the
 * renderers actually receive: the marker must be detectable, and the split
 * must produce spans ONLY for text after it.
 */
import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { TRenderEngine } from '@native-html/transient-render-engine'
import { subtreeHasTailMarker, isTailWrapper, TAIL_MARKER_ATTR } from './TypeIn'

// Same options the app uses.
marked.setOptions({ breaks: true, gfm: true })
const tre = new TRenderEngine({})

function buildTree(markdown: string) {
  return tre.buildTTree(marked.parse(markdown) as string)
}

function flattenText(tnode: any, acc: string[] = []): string[] {
  if (tnode.type === 'text') acc.push(tnode.data)
  ;(tnode.children ?? []).forEach((c: any) => flattenText(c, acc))
  return acc
}

describe('TypeIn × real TRE', () => {
  it('the REAL marker node (type text + tagName span) is detected', () => {
    const ttree = buildTree('hola <span data-tail></span>mundo')
    expect(subtreeHasTailMarker(ttree)).toBe(true)
  })

  it('detects the marker nested inside strong/em/li', () => {
    const ttree = buildTree('a **b<span data-tail></span>c** d')
    expect(subtreeHasTailMarker(ttree)).toBe(true)
    const li = buildTree('- ítem <span data-tail></span>siguiente')
    expect(subtreeHasTailMarker(li)).toBe(true)
  })

  it('no marker → no detection (plain render path)', () => {
    const ttree = buildTree('hola mundo **negrita**')
    expect(subtreeHasTailMarker(ttree)).toBe(false)
  })

  it('a plain span (no data-tail) is NOT the marker', () => {
    const ttree = buildTree('hola <span class="x">mundo</span>')
    expect(subtreeHasTailMarker(ttree)).toBe(false)
  })

  it('marker survives marked → TRE across the tags the renderers cover', () => {
    const cases = [
      'párrafo <span data-tail data-from="8">tail</span>',
      '# título <span data-tail data-from="8">tail</span>',
      '- ítem <span data-tail data-from="6">tail</span>',
      '> quote <span data-tail data-from="7">tail</span>',
      'a **b<span data-tail data-from="4">c</span>**',
      'a *b<span data-tail data-from="4">c</span>*',
      'a <span data-tail data-from="2">b</span>',
    ]
    for (const md of cases) {
      const ttree = buildTree(md)
      expect(subtreeHasTailMarker(ttree), `marker lost for: ${md}`).toBe(true)
    }
  })

  it('marker inside code span degrades gracefully (documented edge case)', () => {
    // marked escapes the marker inside backticks — it becomes literal text.
    const ttree = buildTree('code `x<span data-tail></span>y` fin')
    // Detection must NOT crash; the effect simply won't fire there.
    expect(() => subtreeHasTailMarker(ttree)).not.toThrow()
  })

  it('the wrapper materializes in BOTH real shapes the renderer must catch', () => {
    // The TRE collapses a wrapper with pure-text content into a TText that
    // KEEPS tagName 'span' + attribs (the round-2 finding, now with data).
    // isTailWrapper checks tagName+attribs — never the type — so both
    // shapes are intercepted by the one custom span renderer.
    const find = (n: any): any =>
      n && (isTailWrapper(n) ? n : (n.children ?? []).map(find).find(Boolean))

    // Shape 1 — pure-text tail (the common streaming case):
    const p1 = buildTree('hola <span data-tail data-from="5">mundo</span>').children[0]
    const w1 = find(p1)
    expect(w1).toBeTruthy()
    expect(w1.type).toBe('text')
    expect(w1.tagName).toBe('span')
    expect(w1.data).toBe('mundo')
    expect(w1.domNode.attribs['data-from']).toBe('5')

    // Shape 2 — tagged content inside the tail:
    const p2 = buildTree('hola <span data-tail data-from="5">mundo **cruel**</span>').children[0]
    const w2 = find(p2)
    expect(w2).toBeTruthy()
    expect(w2.type).toBe('phrasing')
    expect(w2.tagName).toBe('span')
    expect(w2.domNode.attribs['data-from']).toBe('5')
    // The prefix stays a SIBLING run, untouched by the renderer.
    expect(flattenText(p2)).toContain('hola ')
  })
})
