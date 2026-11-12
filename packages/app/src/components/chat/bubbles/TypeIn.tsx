/**
 * Type-in effect for streaming chat (TerosTypeIn, DS Motion pattern).
 *
 * The chat reveals text with `useTypewriter` (chunk-by-chunk on a rAF loop).
 * This module adds the DS Motion "type-in" feel on top: the chars revealed
 * by the latest tick enter blurred and settle sharp, while everything
 * before them is already plain text. Spans live ONLY in the in-flight tail
 * — never in the settled prefix, never in the markdown source.
 *
 * Round-3 architecture — the marker is a WRAPPER, not a divider:
 * MarkdownContent wraps the in-flight tail in `<span data-tail
 * data-from="N">…</span>` (N = the boundary, for stable keys). The TRE
 * materializes it as a TPhrasing with tagName 'span', which is the ONE
 * node this module intercepts (custom renderers fire by tagName). The
 * prefix renders 100% default — untouched, fully styled. Inside the
 * wrapper, every text run materializes as per-char type-in spans, and
 * tagged children (strong/em/…) render through the library's default
 * child path (styled, sharp — documented degradation).
 *
 * Why a wrapper: the split point in the earlier architecture (an empty
 * marker between prefix and tail) lands inside an ANONYMOUS phrasing node
 * — not interceptable via the renderers map — so the tagged ancestor (p,
 * li…) had to rebuild its whole subtree, which (a) dropped tag styles
 * (bold rendered plain) and (b) put spans as View children — in the
 * browser, RNW View is flex-column, so every char would stack on its own
 * line. The wrapper keeps everything inside native Text flow: inline.
 *
 * Remount discipline (the Fase-1 lesson): span keys are the char's
 * ABSOLUTE index (data-from + offset), so a boundary that advances folds
 * old chars into the prefix without remounting the ones still animating.
 */
import React from "react"
import { Platform, Text as RNText } from "react-native"
import { TYPEIN } from "../../../hooks/useTypewriter"
import { useColors } from "../../mca/primitives/useColors"

/** The marker attributes inserted by MarkdownContent around the tail. */
export const TAIL_MARKER_ATTR = "data-tail"
/** The settled prefix span (round-4: fixed position child[0], plain render). */
export const SETTLED_MARKER_ATTR = "data-settled"
/** The boundary index carried on the wrapper (stable span keys). */
export const TAIL_FROM_ATTR = "data-from"
/**
 * Reveal-over-rendered path (typeInReveal.ts): the run's chars before this
 * absolute index render plain, the rest as type-in spans. One span per
 * text run, so nothing shifts as the boundary advances.
 */
export const SETTLED_UNTIL_ATTR = "data-settled-until"

/**
 * Text the voice never pronounced (typeInReveal `unheard` mode): rendered
 * default but in the muted grey (`text3`, the overheard tone). The span
 * wraps ONE text run, so it sits inside strong/em and its colour wins.
 */
export const UNHEARD_MARKER_ATTR = "data-unheard"

export function isUnheardSpan(tnode: any): boolean {
  return tnode?.tagName === "span" && tnode?.domNode?.attribs?.[UNHEARD_MARKER_ATTR] !== undefined
}

/** Is this TNode the tail wrapper itself? (tagName+attribs, before any type check) */
export function isTailWrapper(tnode: any): boolean {
  return tnode?.tagName === "span" && tnode?.domNode?.attribs?.[TAIL_MARKER_ATTR] !== undefined
}

/** The settled prefix span — renders default (plain, sharp), fixed child[0]. */
export function isSettledSpan(tnode: any): boolean {
  return tnode?.tagName === "span" && tnode?.domNode?.attribs?.[SETTLED_MARKER_ATTR] !== undefined
}

/**
 * Does this TNode subtree contain the tail wrapper? (Cheap walk — the
 * trees are small.) Kept for tests and defensive checks.
 */
export function subtreeHasTailMarker(tnode: any): boolean {
  if (!tnode) return false
  if (isTailWrapper(tnode)) return true
  if (isSettledSpan(tnode)) return false // settled content is plain — don't recurse
  return (tnode.children ?? []).some(subtreeHasTailMarker)
}

/**
 * Render the in-flight text of one TText node as type-in spans.
 * `from` is the absolute char index where this run starts (stable keys).
 * Web: className + CSS animation (blur → sharp). Native: RN has no
 * `filter` on Text — the entry is an opacity fade instead.
 */
function renderTailText(data: string, from: number): React.ReactNode {
  if (!data) return null
  // Edge spaces: a space at a run's edge collapses against the adjacent
  // run and vanishes — edges become no-break spaces (same as the DS pattern).
  const edgeSafe = (s: string) =>
    (s.startsWith(" ") ? "\u00A0" + s.slice(1) : s).replace(/ $/, "\u00A0")
  const safe = edgeSafe(data)
  if (Platform.OS === "web") {
    return Array.from(safe).map((ch, i) => (
      <span key={from + i} className="ds-typein-char">
        {ch === " " ? "\u00A0" : ch}
      </span>
    ))
  }
  // @todo nira - 2026.10.06 : native tail uses per-char Text nodes with
  // static opacity 1 — the fade needs Animated.Text per span; verify the
  // perf budget on device before wiring the animation.
  return Array.from(safe).map((ch, i) => (
    <RNText key={from + i}>{ch === " " ? "\u00A0" : ch}</RNText>
  ))
}

/**
 * Walk the wrapper's subtree and return its INLINE render output: every
 * TText materializes as type-in spans (the whole subtree is tail), tagged
 * children (strong/em/a…) render through TNodeChildrenRenderer — the
 * library's sanctioned child path, which assembles the full props (a bare
 * TDefaultRenderer call crashes: renderBlockContent reads viewProps/
 * textProps that only the child path injects).
 *
 * `cursor` advances across ALL children so span keys are the char's
 * absolute index — stable across ticks (the Fase-1 remount rule).
 */
function renderWrapperChildren(
  tnode: any,
  cursor: { v: number },
  TNodeChildrenRenderer: any,
  out: React.ReactNode[] = [],
): React.ReactNode[] {
  if (!tnode) return out
  if (tnode.type === "text") {
    const from = cursor.v
    cursor.v += tnode.data?.length ?? 0
    out.push(renderTailText(tnode.data, from))
    return out
  }
  ;(tnode.children ?? []).forEach((child: any, i: number) => {
    if (isTailWrapper(child) || isSettledSpan(child)) {
      // Nested wrapper/settled (defensive — MarkdownContent inserts
      // one of each): skip — the tail walk handles text and tags only.
      return
    }
    if (child.type === "text") {
      const from = cursor.v
      cursor.v += child.data?.length ?? 0
      out.push(renderTailText(child.data, from))
    } else {
      // Tagged child inside the tail: the library's child path (styled,
      // sharp — the documented degradation for styled tail content).
      out.push(<TNodeChildrenRenderer key={`d${i}-${child.nodeIndex}`} tnode={child} />)
      cursor.v += textLength(child)
    }
  })
  return out
}

/** The plain text of a tnode subtree (decoded, document order). */
function collectText(tnode: any): string {
  if (!tnode) return ""
  if (tnode.type === "text") return tnode.data ?? ""
  return (tnode.children ?? []).map(collectText).join("")
}

/**
 * Plain-text length of a tnode subtree (for the key cursor).
 */
function textLength(tnode: any): number {
  if (!tnode) return 0
  if (tnode.type === "text") return tnode.data?.length ?? 0
  return (tnode.children ?? []).reduce((acc: number, c: any) => acc + textLength(c), 0)
}

/**
 * The type-in custom renderers. Only ONE is needed: the wrapper span —
 * the prefix renders default, the wrapper carries the tail. The map is
 * merged into MarkdownContent's renderers only while a boundary is active;
 * without a wrapper in the tree the renderer is a no-op passthrough.
 */
export function buildTypeInRenderers(): Record<string, any> {
  return {
    span: function TypeInSpanRenderer(props: any) {
      const { tnode, TDefaultRenderer, TNodeChildrenRenderer, ...rest } = props
      const c = useColors()
      if (isUnheardSpan(tnode)) {
        return (
          <TDefaultRenderer
            tnode={tnode}
            TNodeChildrenRenderer={TNodeChildrenRenderer}
            {...rest}
            style={{ ...(rest.style ?? {}), color: c.text3 }}
          />
        )
      }
      if (isSettledSpan(tnode)) {
        // The settled prefix (fixed child[0]): plain default render —
        // its content grows as chunks fold, and default-rendering it
        // keeps the whole prefix ONE stable Text (no remounts).
        // ⚠️ TNodeChildrenRenderer MUST go back in the props:
        // getNativePropsForTNode does createElement(TNodeChildrenRenderer)
        // when no children override is given — without it the phrasing
        // settled span crashes ('Element type is invalid: undefined' —
        // the round-4 crash, caught by the PoC error boundary).
        return (
          <TDefaultRenderer tnode={tnode} TNodeChildrenRenderer={TNodeChildrenRenderer} {...rest} />
        )
      }
      if (!isTailWrapper(tnode)) {
        return (
          <TDefaultRenderer tnode={tnode} TNodeChildrenRenderer={TNodeChildrenRenderer} {...rest} />
        )
      }
      // data-from = the boundary when the wrapper was inserted → span
      // keys are absolute char indices, stable as the boundary advances.
      const from = parseInt(tnode.domNode?.attribs?.[TAIL_FROM_ATTR] ?? "0", 10) || 0
      const settledUntil = tnode.domNode?.attribs?.[SETTLED_UNTIL_ATTR]
      if (settledUntil !== undefined) {
        // One run: [plain settled prefix][per-char spans]. The settled part
        // is a bare string (one text node, no spans); the animated part
        // keeps absolute-index keys so a boundary that advances folds
        // chars into the prefix without remounting the ones still moving.
        const until = parseInt(settledUntil, 10) || 0
        const data: string = collectText(tnode)
        const cutAt = Math.max(0, Math.min(data.length, until - from))
        const settled = data.slice(0, cutAt)
        const live = data.slice(cutAt)
        return (
          <TDefaultRenderer tnode={tnode} TNodeChildrenRenderer={TNodeChildrenRenderer} {...rest}>
            {settled ? settled : null}
            {renderTailText(live, from + cutAt)}
          </TDefaultRenderer>
        )
      }
      const children = renderWrapperChildren(tnode, { v: from }, TNodeChildrenRenderer)
      // The wrapper renders as its default (a native Text — inline in the
      // parent's text flow) but with OUR children: the per-char spans.
      // children override → getNativePropsForTNode uses OUR children
      // (TNodeChildrenRenderer not consulted); passed anyway for safety.
      return (
        <TDefaultRenderer tnode={tnode} TNodeChildrenRenderer={TNodeChildrenRenderer} {...rest}>
          {children}
        </TDefaultRenderer>
      )
    },
  }
}

/**
 * The type-in CSS (web only). Same numbers as TYPEIN (single-sourced): the
 * keyframes interpolate the blur and duration constants, the easing is the
 * DS default (cubic-bezier(0.4,0,0.2,1)). Inline-block because filter does
 * not apply to a plain inline box. Fill both holds the from-state
 * (invisible) from mount until the animation starts. Reduced motion gets
 * the finished state, not a slower animation (DS rule 13).
 */
export const TYPEIN_CSS = `
  @keyframes dsTypeIn {
    from { opacity: 0; filter: blur(${TYPEIN.blurCss}); }
    to   { opacity: 1; filter: blur(0); }
  }
  .ds-typein-char {
    /* INLINE, not inline-block: blur/opacity animate fine on inline boxes,
       and inline keeps the text shaping + word-wrap IDENTICAL to plain
       text. inline-boxed chars break lines between any two chars and hang
       spaces differently → the animated tail has different metrics than
       the plain text it folds into → visible reflow jump at every fold
       (measured: char positions diverge ~4.5px after the first space).
       Inline = pixel-perfect fold. */
    display: inline;
    opacity: 0;
    filter: blur(${TYPEIN.blurCss});
    animation: dsTypeIn ${TYPEIN.durationCss} cubic-bezier(0.4, 0, 0.2, 1) both;
  }
  @media (prefers-reduced-motion: reduce) {
    .ds-typein-char { animation: none; opacity: 1; filter: none; }
  }
`
