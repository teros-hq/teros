/**
 * Markdown — the ONE markdown component of the platform (MD-UNIFY).
 *
 * Every surface renders through here: chat bubbles (prose/bubble/plain),
 * MCA tool renderers (plain), board panels (compact), the file viewer and
 * To Do outputs (document), the changelog (external). Policy comes from
 * @teros/shared/markdown, styles from ./styles, code highlighting from
 * ./highlight — this file only assembles.
 *
 * Web:    RenderHtml for the streaming path; html segments via
 *         dangerouslySetInnerHTML + <SyntaxHighlighter> (Prism) for the code
 *         segments, interleaved (the viewer's proven approach, now for every
 *         surface — the segment html is policy-stripped, no raw HTML can
 *         reach the DOM). The web CSS layer (bold tile underlay, image
 *         placeholder) is injected once per theme.
 * Native: RenderHtml over the joined html (code fences render as the styled
 *         pre; Prism stays web-only in this iteration). markdown-it and
 *         react-native-markdown-display are retired.
 *
 * Streaming (chat): `reveal` cuts the parsed HTML at `end` chars and tags the
 * in-flight tail for the per-char type-in (TypeIn.tsx). The renderers map
 * identity is STABLE (module-level) — the Fase-1 remount lesson.
 */
import React, { useMemo } from "react"
import { Platform, useWindowDimensions } from "react-native"
import RenderHtml, { defaultSystemFonts } from "react-native-render-html"

import { FONT_MONO, FONT_SANS, FONT_SERIF, FONT_SERIF_TEXT } from "../mca/primitives/fonts"
import { surface } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"

import { parseSegments, parseMarkdown, parseHtml } from "./parse"
import { RENDERERS, ELEMENT_MODELS, buildRenderersProps } from "./richRenderers"
import { buildTagsStyles, buildWebCss, buildWebTypography, type MarkdownVariant } from "./styles"
import { SyntaxHighlighter, prismStyle } from "./highlight"
import { TYPEIN_CSS } from "../chat/bubbles/TypeIn"
import { revealHtml } from "../chat/bubbles/typeInReveal"

// RenderHtml drops fontFamily values it doesn't know as system fonts — the
// brand faces must be registered or prose falls back to the platform sans.
const BRAND_FONTS = [...defaultSystemFonts, FONT_SANS, FONT_SERIF, FONT_SERIF_TEXT, FONT_MONO]

// Chat voices render through RenderHtml on web too (as the chat always did):
// the streaming reveal and the settled message must be the SAME pipeline, or
// the bubble repaints when the stream ends.
const CHAT_VARIANTS = new Set<MarkdownVariant>(["prose", "bubble", "plain"])

// ─── Web CSS injection (id-keyed, updated in place on theme change) ──────────

let webStyleElement: HTMLStyleElement | null = null
let webStyleThemeKey = ""

function ensureWebStyles(c: ReturnType<typeof useColors>, isDark: boolean) {
  if (typeof document === "undefined") return
  const themeKey = isDark ? "dark" : "light"
  if (webStyleElement && webStyleThemeKey === themeKey) return
  const css = buildWebCss(c, isDark)
  if (webStyleElement) {
    webStyleElement.textContent = css
    webStyleThemeKey = themeKey
    return
  }
  const style = document.createElement("style")
  style.id = "teros-md-styles"
  style.textContent = css
  document.head.appendChild(style)
  webStyleElement = style
  webStyleThemeKey = themeKey
}

// One <style> per distinct (variant, scale, colour, theme) — stable class name,
// created once, never rewritten while mounted (no per-render churn).
const typographyStyles = new Set<string>()

function ensureTypography(
  c: ReturnType<typeof useColors>,
  variant: MarkdownVariant,
  scale: number,
  color: string | undefined,
  isDark: boolean,
): string {
  const key = `${variant}|${scale}|${color ?? ""}|${isDark ? "d" : "l"}`
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  const cls = `tmd-${(h >>> 0).toString(36)}`
  if (typeof document !== "undefined" && !typographyStyles.has(cls)) {
    typographyStyles.add(cls)
    const style = document.createElement("style")
    style.id = cls
    style.textContent = buildWebTypography(c, variant, scale, color, cls)
    document.head.appendChild(style)
  }
  return cls
}

// ─── Code segment renderer (Prism) ───────────────────────────────────────────

function CodeBlock({ lang, code, isDark }: { lang: string; code: string; isDark: boolean }) {
  const c = useColors()
  return (
    <div data-fx="cloud" style={{ position: "relative", marginTop: 8, marginBottom: 8 }}>
      <SyntaxHighlighter
        language={lang || "text"}
        style={prismStyle(isDark)}
        customStyle={{
          borderRadius: 16,
          fontSize: 12.5,
          margin: 0,
          lineHeight: 1.55,
          fontFamily: `'${FONT_MONO}', monospace`,
          background: c.bgStep,
          padding: "14px 16px",
          boxShadow: c.liftSm,
        }}
        codeTagProps={{ style: { fontFamily: `'${FONT_MONO}', monospace` } }}
        PreTag="div"
        showLineNumbers={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

// ─── Public component ────────────────────────────────────────────────────────

export interface MarkdownReveal {
  /** Rendered chars shown so far; the rest of the document is cut. */
  end: number
  /** Where the in-flight tail starts (chars from here enter blurred), or null. */
  boundary: number | null
  /** Keep the text past `end` and paint it muted instead of cutting it (interrupted voice reply). */
  unheard?: boolean
}

export interface MarkdownProps {
  text: string
  /** Visual role — see styles.ts for the scale of each. */
  variant?: MarkdownVariant
  /** Scale factor (chat compact mode ≈ 0.73). */
  scale?: number
  /** Body colour override (the user bubble reads Main/800 on the mint glow). */
  color?: string
  /** Streaming reveal (chat). */
  reveal?: MarkdownReveal | null
  /** Width override for RenderHtml's contentWidth. */
  width?: number
  /** `external` allows external images; every other variant blocks them. */
  allowExternalImages?: boolean
}

export function Markdown({
  text,
  variant = "plain",
  scale = 1,
  color,
  reveal,
  width,
  allowExternalImages,
}: MarkdownProps) {
  const c = useColors()
  const { width: windowWidth } = useWindowDimensions()
  const isDark = c.bgPage === surface.dark.bgPage

  const end = reveal?.end
  const boundary = reveal?.boundary ?? null
  const unheard = reveal?.unheard === true
  const streaming = reveal != null
  const imagesAllowed = allowExternalImages ?? variant === "external"
  const prose = variant === "prose"
  const chat = CHAT_VARIANTS.has(variant)
  // RenderHtml: streaming, every native render, and the chat voices on web.
  const richHtml = streaming || chat || Platform.OS !== "web"

  // All hooks BEFORE any conditional return (React rules of hooks).
  const segments = useMemo(
    () => (richHtml ? null : parseSegments(text, { allowExternalImages: imagesAllowed })),
    [text, richHtml, imagesAllowed],
  )

  const html = useMemo(() => {
    if (!richHtml) return null
    if (streaming) {
      const full = parseMarkdown(text)
      return end == null ? full : revealHtml(full, boundary, end, { unheard })
    }
    // Chat keeps the pre-unification parity (the same html StreamingProse
    // measured); the other surfaces block external images.
    return chat ? parseMarkdown(text) : parseHtml(text, { allowExternalImages: imagesAllowed })
  }, [richHtml, streaming, chat, text, end, boundary, unheard, imagesAllowed])

  const tagsStyles = useMemo(
    () => buildTagsStyles(c, variant, scale, color),
    [c, variant, scale, color],
  )

  const renderersProps = useMemo(() => buildRenderersProps(c, isDark, prose), [c, isDark, prose])

  const contentWidth = width ?? windowWidth * 0.85

  // ── RenderHtml path: streaming (chat), native, and chat voices on web ──
  if (html != null) {
    return (
      <>
        {Platform.OS === "web" && streaming && <style>{TYPEIN_CSS}</style>}
        <RenderHtml
          systemFonts={BRAND_FONTS}
          contentWidth={contentWidth}
          source={{ html }}
          tagsStyles={tagsStyles}
          defaultTextProps={{ selectable: true }}
          renderers={prose ? RENDERERS.prose : RENDERERS.other}
          customHTMLElementModels={ELEMENT_MODELS}
          renderersProps={renderersProps}
        />
      </>
    )
  }

  // ── Web static path: html segments + Prism code segments ──
  ensureWebStyles(c, isDark)
  const cls = ensureTypography(c, variant, scale, color, isDark)
  return (
    <div className={`teros-md ${cls}`}>
      {segments!.map((seg, i) =>
        seg.type === "html" ? (
          // The segment html is policy-stripped (renderer.html returns ''
          // for raw tokens) — no unsanitized markup can reach the DOM.
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.content }} />
        ) : (
          <CodeBlock key={i} lang={seg.lang} code={seg.code} isDark={isDark} />
        ),
      )}
    </div>
  )
}
