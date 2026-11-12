/**
 * Type-in reveal over RENDERED markdown ("parse ahead, reveal behind").
 *
 * The old pipeline parsed the typewriter-cut SOURCE, so the markdown of the
 * tail was incomplete: '**bo' rendered as literal asterisks until the closer
 * arrived, a '#' line was plain text until it folded into a heading. This
 * module takes the HTML of the FULL source (parsed ahead) and reveals its
 * rendered characters in place: every char appears where it will stay, in
 * its final style. The structure never changes under revealed text — only
 * new text (and the elements it lives in) gets appended.
 *
 *   renderedText(html)                 the plain text the reveal counts over
 *   revealHtml(html, boundary, end)    HTML truncated at `end` rendered chars,
 *                                      runs crossing `boundary` tagged for the
 *                                      per-char type-in spans (TypeIn.tsx)
 *
 * Counting unit: one DECODED character (an entity like &amp; counts as 1 —
 * the TRE hands the renderer decoded text, so indices must match).
 * <pre> blocks are plain: their text is truncated at `end` but never gets
 * spans (code streams plain, as documented for the old pipeline).
 */

export const SETTLED_UNTIL_ATTR = "data-settled-until"

type Tok =
  | { kind: "tag"; raw: string; name: string; closing: boolean; selfClosing: boolean }
  | { kind: "text"; raw: string; chars: string[] } // chars: raw per decoded char

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "wbr", "source"])

/** Tokenise an HTML string into tags and text runs (entities kept raw, one per char). */
function tokenize(html: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = html.length
  while (i < n) {
    if (html[i] === "<") {
      // comment
      if (html.startsWith("<!--", i)) {
        const e = html.indexOf("-->", i + 4)
        const end = e < 0 ? n : e + 3
        out.push({
          kind: "tag",
          raw: html.slice(i, end),
          name: "!--",
          closing: false,
          selfClosing: true,
        })
        i = end
        continue
      }
      const e = html.indexOf(">", i + 1)
      if (e < 0) {
        out.push({ kind: "text", raw: html.slice(i), chars: splitChars(html.slice(i)) })
        break
      }
      const raw = html.slice(i, e + 1)
      const m = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(raw)
      const name = m ? m[1].toLowerCase() : ""
      const closing = raw.startsWith("</")
      const selfClosing = raw.endsWith("/>") || VOID.has(name)
      out.push({ kind: "tag", raw, name, closing, selfClosing })
      i = e + 1
      continue
    }
    const e = html.indexOf("<", i)
    const end = e < 0 ? n : e
    const raw = html.slice(i, end)
    out.push({ kind: "text", raw, chars: splitChars(raw) })
    i = end
  }
  return out
}

/** Split a raw text run into decoded-char units: an entity is one unit. */
function splitChars(raw: string): string[] {
  const chars: string[] = []
  let i = 0
  while (i < raw.length) {
    if (raw[i] === "&") {
      const m = /^&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/.exec(raw.slice(i, i + 12))
      if (m) {
        chars.push(m[0])
        i += m[0].length
        continue
      }
    }
    const cp = raw.codePointAt(i) as number
    const len = cp > 0xffff ? 2 : 1
    chars.push(raw.slice(i, i + len))
    i += len
  }
  return chars
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}
function decodeUnit(u: string): string {
  if (u[0] !== "&") return u
  const body = u.slice(1, -1)
  if (body[0] === "#") {
    const code =
      body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : u
  }
  return ENTITIES[body] ?? u
}

/** Marker on the text runs the voice never pronounced (muted render, TypeIn.tsx). */
export const UNHEARD_ATTR = "data-unheard"

/** The decoded plain text of the HTML, in document order (the reveal's ruler). */
export function renderedText(html: string): string {
  let s = ""
  for (const t of tokenize(html)) if (t.kind === "text") for (const u of t.chars) s += decodeUnit(u)
  return s
}

/**
 * Truncate the HTML at `end` rendered chars and tag the in-flight runs.
 *
 * - runs entirely before `boundary`      → emitted as plain text (settled)
 * - runs intersecting [boundary, end)    → `<span data-tail data-from="S"
 *                                           data-settled-until="B">…</span>`
 *   (ONE node per run, so positions never shift as the boundary advances —
 *   the renderer splits settled/animated chars itself)
 * - anything after the last revealed char → dropped; the open tag stack is
 *   closed so the document stays well-formed and no empty block appears
 * - <pre> text: plain, truncated, never tagged
 */
export function revealHtml(
  html: string,
  boundary: number | null,
  end: number,
  opts: { unheard?: boolean } = {},
): string {
  const toks = tokenize(html)
  const out: string[] = []
  const stack: string[] = []
  let pos = 0 // decoded chars emitted so far
  let inPre = 0
  const b = boundary == null ? end : Math.min(boundary, end)
  // Voice PoC 2026-10-31 (Pablo): an interrupted reply keeps its WHOLE prose,
  // with everything after the heard char painted muted (same grey as the
  // overheard rows). Nothing is cut: text runs past `end` are wrapped in
  // `<span data-unheard>` (one per run, so bold/em inside the tail still
  // take the muted colour) and the document structure stays intact.
  const unheard = opts.unheard === true
  const muted = (s: string) => (s ? `<span ${UNHEARD_ATTR}>${s}</span>` : "")
  let cut = false
  for (const t of toks) {
    if (cut) break
    if (t.kind === "tag") {
      if (t.name === "!--") continue
      if (t.closing) {
        // Close only what is open; stray closers dropped.
        const k = stack.lastIndexOf(t.name)
        if (k >= 0) stack.length = k
        if (t.name === "pre") inPre--
        out.push(t.raw)
      } else {
        if (!t.selfClosing) stack.push(t.name)
        if (t.name === "pre") inPre++
        out.push(t.raw)
      }
      continue
    }
    const len = t.chars.length
    if (len === 0) continue
    const start = pos
    const runEnd = pos + len
    if (runEnd <= b || inPre > 0) {
      // Fully settled (or code): plain, truncated at `end`.
      if (runEnd <= end) {
        out.push(t.raw)
        pos = runEnd
      } else {
        const keepN = Math.max(0, end - start)
        out.push(t.chars.slice(0, keepN).join(""))
        pos = end
        if (unheard) {
          out.push(muted(t.chars.slice(keepN).join("")))
          pos = runEnd
        } else {
          cut = true
        }
      }
      continue
    }
    if (start >= end) {
      if (unheard) {
        out.push(muted(t.raw))
        pos = runEnd
        continue
      }
      cut = true
      break
    }
    // In-flight run: one span, truncated at `end`.
    const keep = Math.min(len, end - start)
    out.push(
      `<span data-tail data-from="${start}" ${SETTLED_UNTIL_ATTR}="${Math.max(start, b)}">${t.chars.slice(0, keep).join("")}</span>`,
    )
    pos = start + keep
    if (keep < len) {
      if (unheard) {
        out.push(muted(t.chars.slice(keep).join("")))
        pos = runEnd
      } else {
        cut = true
      }
    }
  }
  if (cut) {
    // Drop the trailing tags of the current element that were already
    // pushed AFTER the last text? (none — tags are only emitted before
    // their text). Close the open stack.
    for (let i = stack.length - 1; i >= 0; i--) out.push(`</${stack[i]}>`)
    // Remove empty blocks opened right before the cut: an element opened
    // with no text emitted since its opener. Simple pass on the output.
    return stripEmptyTail(out.join(""))
  }
  return out.join("")
}

/**
 * Remove elements left EMPTY at the end of the document by the cut (an
 * opener pushed before the first hidden char, e.g. `<h2></h2>` or
 * `<li></li>` placeholders), repeatedly, so nothing renders ahead of the
 * text that will fill it.
 */
function stripEmptyTail(html: string): string {
  let s = html
  for (;;) {
    const m = /<([a-zA-Z][\w:-]*)[^>]*>(\s*(<br\s*\/?>)?\s*)<\/\1>\s*$/.exec(s)
    if (!m) return s
    s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
    s = s.replace(/\s+$/, "")
  }
}
