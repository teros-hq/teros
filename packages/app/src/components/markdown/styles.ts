/**
 * The ONE style layer of the platform's markdown (MD-UNIFY, D1/D2/D7).
 *
 * One buildTagsStyles() serves every surface. What the audit found as four
 * divergent recipes becomes variants of a single scale — same structure, same
 * colours, same rules everywhere:
 *
 *   · weight 400 everywhere (DS: hierarchy by size, never bold)
 *   · bold = the To Do kit's tile underlay (violet wash) + text colour
 *   · em = italic (chat's "accent upright" was the outlier — unified to italic)
 *   · inline code = navActive + accent
 *   · code block = bgStep card r16 + lift, Prism-highlighted (all surfaces)
 *   · table = bgStep card r12, th wash + caps 10px, hairline rows
 *   · h4 = caps accent eyebrow; h5/h6 = caps text3
 *   · checkbox glyphs .md-check (accent) / .md-check-on
 *   · links = accent, no underline, _blank noopener (parse layer)
 *
 * Variants only change SCALE and the body face — never structure or colour:
 *   prose    17/25 serif body (Ivory Light) — agent replies
 *   plain    15/24 sans — tool renderers, system messages
 *   bubble   16/23 sans — the user bubble
 *   compact  13/19.5 sans — board panels (instructions, previews)
 *   document 15/25 serif body, h1 26 / h2 underline — viewer, To Do output
 *   external as document but external images allowed — changelog
 */
import { Platform } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { FONT_MONO, FONT_SANS, FONT_SERIF, FONT_SERIF_TEXT } from "../mca/primitives/fonts"

export type MarkdownVariant = "prose" | "plain" | "bubble" | "compact" | "document" | "external"

export interface VariantSpec {
  bodyFont: string
  bodySize: number
  bodyLine: number
  blockGap: number
  h1: number
  h2: number
  h3: number
  h2Rule?: boolean
}

const SPECS: Record<MarkdownVariant, VariantSpec> = {
  prose: { bodyFont: FONT_SERIF_TEXT, bodySize: 17, bodyLine: 25, blockGap: 14, h1: 28, h2: 24, h3: 22 },
  plain: { bodyFont: FONT_SANS, bodySize: 15, bodyLine: 24, blockGap: 8, h1: 22, h2: 19, h3: 17 },
  bubble: { bodyFont: FONT_SANS, bodySize: 16, bodyLine: 23, blockGap: 8, h1: 22, h2: 19, h3: 17 },
  compact: { bodyFont: FONT_SANS, bodySize: 13, bodyLine: 19.5, blockGap: 6, h1: 18, h2: 16, h3: 14 },
  // document/external: Saans body + Prody headings — the pre-unification
  // behavior of the viewer ("Prody headings, Saans body"), the To Do outputs
  // (F.sans body) and the changelog. Ivory serif is the chat agent's voice
  // ONLY (prose) — Pablo 2026-10-31: "la fuente no es la que toca".
  document: { bodyFont: FONT_SANS, bodySize: 15, bodyLine: 25, blockGap: 12, h1: 26, h2: 20, h3: 17, h2Rule: true },
  external: { bodyFont: FONT_SANS, bodySize: 14, bodyLine: 23, blockGap: 10, h1: 22, h2: 19, h3: 17, h2Rule: true },
}

export function variantSpec(variant: MarkdownVariant): VariantSpec {
  return SPECS[variant] ?? SPECS.plain
}

/**
 * Build the RenderHtml tagsStyles for a variant. `scale` shrinks everything
 * (the chat's compact mode renders at ~0.73).
 */
export function buildTagsStyles(
  c: ReturnType<typeof useColors>,
  variant: MarkdownVariant = "plain",
  scale = 1,
  color?: string,
): any {
  const s = variantSpec(variant)
  const prose = variant === "prose"
  const document = variant === "document" || variant === "external"
  const r = (n: number) => Math.round(n * scale)
  return {
    body: {
      color: color ?? c.text,
      fontFamily: s.bodyFont,
      fontWeight: prose ? ("300" as const) : ("400" as const),
      fontSize: r(s.bodySize),
      lineHeight: r(s.bodyLine),
      ...(prose ? { letterSpacing: 0.34 } : {}),
      ...(Platform.OS === "web" ? { userSelect: "text", cursor: "text" } : {}),
    },
    p: { marginTop: 0, marginBottom: r(s.blockGap) },
    // DS: emphasis is never bold — bold is the tile underlay + text colour.
    // Chat prose (the agent's voice) keeps its DS look: bold and em are the
    // accent, upright — `.prose strong/em`.
    strong: { fontWeight: "400" as const, color: prose ? c.accent : (color ?? c.text) },
    b: { fontWeight: "400" as const, color: prose ? c.accent : (color ?? c.text) },
    em: prose ? { fontStyle: "normal" as const, color: c.accent } : { fontStyle: "italic" as const },
    // The To Do kit's tile underlay — drawn by the web CSS layer below on web;
    // on native the wash background approximates it.
    code: {
      backgroundColor: c.navActive,
      color: c.accent,
      paddingHorizontal: r(6),
      paddingVertical: 1,
      borderRadius: 4,
      fontFamily: FONT_MONO,
      fontSize: r(s.bodySize - 2),
      letterSpacing: 0,
    },
    // Code blocks render as Prism <SyntaxHighlighter> components (parse layer
    // emits code segments); this pre style is the fallback for no-lang fences.
    pre: {
      backgroundColor: c.bgStep,
      padding: r(14),
      borderRadius: 16,
      marginVertical: r(s.blockGap),
      fontFamily: FONT_MONO,
      fontSize: r(12.5),
      color: c.text,
      ...(Platform.OS === "web" ? { boxShadow: c.liftSm } : {}),
    },
    ul: { marginTop: 0, marginBottom: r(s.blockGap), paddingLeft: r(20) },
    ol: { marginTop: 0, marginBottom: r(s.blockGap), paddingLeft: r(26) },
    li: {
      marginTop: 0,
      marginBottom: r(prose ? 8 : 4),
      ...(prose ? { fontFamily: FONT_SANS, fontSize: 16, lineHeight: 24, color: c.text2, letterSpacing: 0 } : {}),
    },
    a: { color: c.accent, textDecorationLine: "none" as const },
    blockquote: prose
      ? {
          // `.prose blockquote`: a card (the web renderer draws the gradient bar).
          backgroundColor: c.bgStep,
          borderWidth: 1,
          borderColor: c.border,
          borderLeftWidth: Platform.OS === "web" ? 1 : 3,
          borderLeftColor: Platform.OS === "web" ? c.border : c.accent,
          borderRadius: 16,
          marginVertical: r(s.blockGap),
          marginLeft: 0,
          marginRight: 0,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 22,
          paddingRight: 20,
          fontFamily: FONT_SANS,
          fontSize: 15,
          lineHeight: 23,
          letterSpacing: 0,
          color: c.text2,
        }
      : document
      ? {
          borderLeftWidth: 3,
          borderLeftColor: c.accent,
          backgroundColor: c.wash,
          borderRadius: 12,
          marginVertical: r(s.blockGap),
          marginLeft: 0,
          paddingLeft: r(14),
          paddingRight: r(12),
          paddingVertical: r(8),
          color: c.text2,
        }
      : {
          borderLeftWidth: 3,
          borderLeftColor: c.borderStrong,
          marginVertical: r(8),
          paddingLeft: r(12),
          color: c.text2,
        },
    h1: {
      marginTop: r(s.blockGap + 12),
      marginBottom: r(s.blockGap),
      fontWeight: "400" as const,
      fontFamily: FONT_SERIF,
      color: color ?? c.text,
      fontSize: r(s.h1),
      lineHeight: r(s.h1 + 5),
      letterSpacing: 0,
    },
    h2: {
      marginTop: r(s.blockGap + 12),
      marginBottom: r(s.blockGap),
      fontWeight: "400" as const,
      fontFamily: FONT_SERIF,
      color: color ?? c.text,
      fontSize: r(s.h2),
      lineHeight: r(s.h2 + 5),
      letterSpacing: 0,
      ...(s.h2Rule ? { borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: r(4) } : {}),
    },
    h3: {
      marginTop: r(s.blockGap + 10),
      marginBottom: r(s.blockGap),
      fontWeight: "400" as const,
      fontFamily: FONT_SERIF,
      color: color ?? c.text,
      fontSize: r(s.h3),
      lineHeight: r(s.h3 + 5),
      letterSpacing: 0,
    },
    // h4 = the caps accent eyebrow (DS).
    h4: {
      marginTop: r(s.blockGap + 10),
      marginBottom: r(s.blockGap - 2),
      fontWeight: "400" as const,
      fontFamily: FONT_SANS,
      fontSize: r(10),
      lineHeight: r(12),
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      color: c.accent,
    },
    h5: {
      marginTop: r(s.blockGap + 8),
      marginBottom: r(s.blockGap - 2),
      fontWeight: "400" as const,
      fontFamily: FONT_SANS,
      fontSize: r(10),
      lineHeight: r(12),
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      color: c.text2,
    },
    h6: {
      marginTop: r(s.blockGap + 8),
      marginBottom: r(s.blockGap - 2),
      fontWeight: "400" as const,
      fontFamily: FONT_SANS,
      fontSize: r(10),
      lineHeight: r(12),
      letterSpacing: 1.8,
      textTransform: "uppercase" as const,
      color: c.text3,
    },
    hr: {
      height: 1,
      backgroundColor: c.border,
      borderWidth: 0,
      marginVertical: r(s.blockGap + 4),
    },
    img: { borderRadius: 12 },
    // The unified table: bgStep card r12, th wash + caps, hairline rows.
    table: {
      backgroundColor: c.bgStep,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      marginVertical: r(s.blockGap),
      overflow: "hidden" as const,
    },
    th: {
      backgroundColor: c.wash,
      padding: r(8),
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      fontWeight: "400" as const,
      fontSize: r(10),
      letterSpacing: 1.4,
      textTransform: "uppercase" as const,
      color: c.text2,
    },
    td: {
      padding: r(8),
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      color: color ?? c.text2,
    },
    tr: { borderBottomWidth: 1, borderBottomColor: c.border },
    // Task-list checkbox glyphs (parse layer emits .md-check spans).
    "md-check": { color: c.accent, fontSize: r(s.bodySize - 1) },
    "md-check-on": { color: c.accent },
  }
}

/**
 * Web CSS for the things tagsStyles cannot express: the bold tile underlay
 * (background-image) and the blocked-image placeholder. Injected once per
 * theme by Markdown.tsx (id-keyed <style>, updated in place).
 */
export function buildWebCss(c: ReturnType<typeof useColors>, isDark: boolean): string {
  const boldTile = isDark ? "rgba(156,107,255,0.14)" : "rgba(111,39,255,0.12)"
  return `
  .teros-md strong, .teros-md b {
    font-weight: 400;
    background-image: linear-gradient(transparent 62%, ${boldTile} 62%);
  }
  .teros-md .md-check { color: ${c.accent}; }
  .teros-md .md-check-on { color: ${c.accent}; }
  .teros-md .md-img-placeholder {
    display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px;
    padding: 10px 14px; margin: 4px 0;
    border: 1px dashed ${c.border}; border-radius: 12px;
    background: ${c.wash}; font-size: 12px; color: ${c.text3};
    max-width: 100%; box-sizing: border-box;
  }
  .teros-md .md-img-placeholder-url {
    font-family: '${FONT_MONO}', monospace; font-size: 11px;
    color: ${c.text3}; word-break: break-all;
  }
  .teros-md pre { overflow-x: auto; }
  `
}

// ─── Web typography from the SAME spec (single source of truth) ──────────────
// RenderHtml applies tagsStyles on native + streaming; the web static path
// injects the segment html raw, so the DS typography must reach it as CSS.
// (5c66d7e78 shipped without this: on web, links/quotes/tables/hr/lists/headings
// fell back to browser defaults.)

const UNITLESS = new Set(["fontWeight", "opacity", "flex", "zIndex"])
const KEBAB = (k: string) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())

function cssDecls(style: Record<string, any>): string {
  const out: string[] = []
  let hasBorder = false
  const put = (k: string, v: any) => out.push(`${k}:${v};`)
  const px = (k: string, v: any) => (typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : v)
  for (const [k, v] of Object.entries(style)) {
    if (v == null) continue
    switch (k) {
      case "paddingHorizontal":
        put("padding-left", px(k, v)); put("padding-right", px(k, v)); break
      case "paddingVertical":
        put("padding-top", px(k, v)); put("padding-bottom", px(k, v)); break
      case "marginHorizontal":
        put("margin-left", px(k, v)); put("margin-right", px(k, v)); break
      case "marginVertical":
        put("margin-top", px(k, v)); put("margin-bottom", px(k, v)); break
      case "textDecorationLine":
        put("text-decoration", v); break
      case "userSelect": case "cursor": case "boxShadow":
        put(KEBAB(k), v); break
      default:
        if (/^border.*Width$/.test(k)) hasBorder = true
        put(KEBAB(k), px(k, v))
    }
  }
  // Unspecified sides must stay 0 (CSS default is `medium`): reset first.
  return hasBorder ? `border-width:0;border-style:solid;${out.join("")}` : out.join("")
}

/** CSS for every tag of the variant, scoped under `.${cls}`. */
export function buildWebTypography(
  c: ReturnType<typeof useColors>,
  variant: MarkdownVariant,
  scale: number,
  color: string | undefined,
  cls: string,
): string {
  const tags = buildTagsStyles(c, variant, scale, color)
  const rules: string[] = []
  for (const [tag, style] of Object.entries<Record<string, any>>(tags)) {
    const sel = tag === "body" ? `.${cls}` : tag.startsWith("md-") ? `.${cls} .${tag}` : `.${cls} ${tag}`
    rules.push(`${sel}{${cssDecls(style)}}`)
  }
  // Tag defaults the spec does not state (first/last child flush, box model).
  rules.push(`.${cls}{box-sizing:border-box;width:100%}`)
  rules.push(`.${cls} > div > :first-child{margin-top:0}.${cls} > div > :last-child{margin-bottom:0}`)
  rules.push(`.${cls} table{display:table;width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}`)
  rules.push(`.${cls} th,.${cls} td{text-align:left;vertical-align:top}`)
  // GFM column alignment (:---: / ---:) arrives as the align attribute.
  rules.push(`.${cls} th[align=center],.${cls} td[align=center]{text-align:center}`)
  rules.push(`.${cls} th[align=right],.${cls} td[align=right]{text-align:right}`)
  rules.push(`.${cls} img{max-width:100%;height:auto;display:block}`)
  rules.push(`.${cls} hr{border:0}`)
  rules.push(`.${cls} pre code,.${cls} [data-fx="cloud"] code,.${cls} [data-fx="cloud"] span{background:none;padding:0;border-radius:0;font-size:inherit}`)
  return rules.join("\n")
}
