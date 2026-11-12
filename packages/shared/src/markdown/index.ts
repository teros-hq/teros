/**
 * The ONE markdown parse policy of the platform (MD-UNIFY, D1–D4 in
 * docs/specs/20261030_markdown-unification.md).
 *
 * Every surface that turns markdown into HTML parses through here: the app's
 * unified renderer (packages/app/src/components/markdown), the public share
 * pages (backend http-share-handler) and, going forward, the email MCAs.
 * Before this module the policy lived as 6 copies of the same patch with
 * divergent gfm/breaks flags — and the app's copies mutated the GLOBAL marked
 * singleton, so the last surface to render decided how every other one
 * behaved (audit finding F1).
 *
 * Policy (approved by Pablo, 2026-10-31):
 *   gfm: true   tables, task lists, autolinks…
 *   breaks:true single newlines break (chat semantics — agent output is full
 *               of single-newline lines that would otherwise glue together)
 *   noStrike    MD-STRIKE-1: `~~x~~` and `~50ms` render LITERAL — agents write
 *               approximations (~aprox~), latencies (~50ms) and paths, never
 *               strikethrough
 *   no raw HTML marked v17 funnels block AND inline raw HTML through
 *               renderer.html — returning '' strips it before it ever exists
 *               (audit F2: the viewer/FVU/share pages injected it unsanitized)
 *   safe URLs   javascript:/data:/vbscript: hrefs are dropped (link/image
 *               renderers return the plain text instead)
 *   checkboxes  task-list checkboxes render as ☐/☑ glyph spans (class
 *               md-check) — cross-platform, styled by the renderer layer
 */
import { Marked, Tokenizer } from 'marked'

/** URLs markdown may link/embed. Everything else (javascript:, data:…) → plain text. */
const SAFE_URL = /^(?:https?:|mailto:|tel:|\/|#|\.\/)/i

export interface TerosMarkdownOptions {
  /**
   * Keep raw HTML tokens as text instead of stripping them. Nothing in the
   * platform needs this today — it exists so a future surface can opt in
   * deliberately instead of reaching for a second parser.
   */
  keepRawHtml?: boolean
}

/**
 * A configured private Marked instance. NEVER call `marked.setOptions` on the
 * global singleton — that is finding F1. Each consumer builds (once) or takes
 * `terosMarkdown` below.
 */
export function createTerosMarked(options: TerosMarkdownOptions = {}): Marked {
  const md = new Marked({ gfm: true, breaks: true })

  // MD-STRIKE-1 — the tilde renders literal. A tokenizer whose `del` never
  // matches makes marked skip strikethrough entirely.
  const noStrike = new Tokenizer()
  noStrike.del = function () {
    return undefined
  }
  md.use({ tokenizer: noStrike })

  md.use({
    renderer: {
      // Raw HTML (block <script>… and inline <img onerror=…>) never reaches
      // the output. marked v17 routes both through renderer.html; returning ''
      // strips the token. keepRawHtml opts a surface back in deliberately.
      html(token: any) {
        if (options.keepRawHtml === true) return token?.text ?? ''
        return ''
      },
      // Task-list checkbox → glyph span; the renderer layer styles .md-check
      // (accent colour) and .md-check-on (filled) via classesStyles.
      // v17 passes a token object { checked }, not a boolean.
      checkbox(token: any) {
        return token?.checked
          ? '<span class="md-check md-check-on">☑</span>'
          : '<span class="md-check">☐</span>'
      },
      link(token: any) {
        const text = this.parser.parseInline(token.tokens ?? [])
        if (!SAFE_URL.test(token.href ?? '')) return text
        return `<a href="${token.href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      },
      image(token: any) {
        if (!SAFE_URL.test(token.href ?? '')) return token.text ?? ''
        return `<img src="${token.href}" alt="${token.text ?? ''}">`
      },
    } as any,
  })

  return md
}

/**
 * The platform's markdown instance. Import this (or createTerosMarked for an
 * isolated one) — never configure the global `marked`.
 */
export const terosMarkdown = createTerosMarked()

/** Parse markdown → HTML with the platform policy. */
export function renderMarkdown(source: string): string {
  return terosMarkdown.parse(source) as string
}
