/**
 * FileTypeBody — the per-type BODY of the FVU widget (spec FVU-REQ-3, ux §3.2).
 *
 * The only variable part of the universal widget: the strip + action row are
 * identical for every file; this component renders the body by kind using the
 * single render table (fileRenderers.ts):
 *
 *   markdown → formatted (reuses the MarkdownViewer render layer)
 *   image    → inline viewer, object-fit contain, max-height 360-400px,
 *              click = fullscreen (current ImageBubble pattern)
 *   pdf      → native embed (OQ2 decision: browser embed suffices on web;
 *              no pdf.js dependency for the MVP), ~260px + bottom fade,
 *              vertical scroll inside the embed
 *   audio    → compact player (current AudioBubble pattern)
 *   video    → native controls player (current VideoBubble pattern)
 *   csv      → tolerant table, sticky header, horizontal scroll, zebra rows
 *   json     → syntax highlight (same highlighter the MarkdownViewer uses)
 *   text     → quiet monospace, pre-wrap
 *   fallback → big icon + name + size + subtype (a valid state, never an error)
 *
 * Text bodies are inert and selectable — no action fires from the body.
 */
import React, { useMemo, useState } from "react"
import { Image, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native"
import WebView from "react-native-webview"
import { useColors } from "../../mca/primitives/useColors"
import { Ph, T } from "../../ui/ds"
import { FONT_MONO } from "../../mca/primitives/fonts"
import { MarkdownRenderer } from "../../../windows/MarkdownViewerWindow/components/MarkdownRenderer"
import { SyntaxHighlighter, useSyntaxTheme } from "./jsonHighlight"
import {
  formatFileSize,
  getRenderKind,
  isInlineRenderable,
  kindIcon,
  kindLabel,
  type FileRenderKind,
} from "./fileRenderers"

export interface FileTypeBodyProps {
  kind: FileRenderKind
  filename: string
  /** Media URL — used by image/audio/video/pdf bodies. */
  url: string
  /** Text content when already fetched (live files); fetched by the parent. */
  textContent?: string | null
  /** File size in bytes (fallback body + size guard). */
  size?: number
  /** Open the immersive fullscreen overlay (image click wires here). */
  onFullscreen?: () => void
  /** v1.3.0 window context: fill the available height and drop the inline
   *  maxHeight caps — the parent ScrollView scrolls (the chat bubble keeps
   *  its capped bodies). */
  fill?: boolean
  testID?: string
}

// ─── CSV (tolerant parse, no library) ────────────────────────────────────────

/** Minimal tolerant CSV parser: quotes, escaped quotes, CRLF. Malformed
 *  cells pass through as raw text (spec edge case — never throws). */
export function parseCsv(text: string, maxRows = 50): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      cell = ""
      if (row.length > 1 || row[0] !== "") rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.length > 1 || row[0] !== "") rows.push(row)
  return rows.slice(0, maxRows)
}

function CsvTable({
  text,
  fill,
  testID,
}: {
  text: string
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  const rows = useMemo(() => parseCsv(text), [text])
  const [header, ...body] = rows
  const truncated = useMemo(() => parseCsv(text, Infinity).length > rows.length, [text, rows])
  // v1.3.5: shared column widths — every row sized its own cells before
  // (minWidth per cell), so wide cells pushed their row and the rest came
  // out ragged (Pablo: "las filas no comparten anchos de columna"). A single
  // CSS grid with N equal columns keeps column N the same width in every row.
  const colCount = Math.max(header?.length ?? 0, ...body.map((r) => r.length))
  // CSS grid is web-only — RN's ViewStyle type doesn't know it, hence the cast.
  const gridTemplate: any = {
    display: "grid",
    gridTemplateColumns: `repeat(${colCount}, minmax(96px, 1fr))`,
  }

  return (
    <View testID={testID} style={fill ? { flex: 1 } : { maxHeight: 320 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {/* Header row — shared grid, sticky look, column separators */}
          <View style={{ ...gridTemplate, backgroundColor: c.nest }}>
            {header?.map((h, i) => (
              <T
                key={i}
                step="codenote"
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  color: c.text2,
                  fontWeight: "600",
                  borderRightWidth: i < (header?.length ?? 0) - 1 ? 1 : 0,
                  borderRightColor: c.border,
                  overflow: "hidden",
                }}
                ellipsis
              >
                {h}
              </T>
            ))}
          </View>
          {/* Zebra body rows — SAME grid template → aligned columns */}
          {body.map((r, ri) => (
            <View
              key={ri}
              style={{
                ...gridTemplate,
                backgroundColor: ri % 2 === 0 ? "transparent" : c.nest,
              }}
            >
              {r.map((cell, ci) => (
                <T
                  key={ci}
                  step="codenote"
                  selectable
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    color: c.text2,
                    borderRightWidth: ci < (r.length - 1) ? 1 : 0,
                    borderRightColor: c.border,
                    overflow: "hidden",
                  }}
                  ellipsis
                >
                  {cell}
                </T>
              ))}
            </View>
          ))}
          {truncated && (
            <T step="codenote" tone="text3" style={{ padding: 8 }}>
              +{parseCsv(text, Infinity).length - rows.length} more rows — open in FileViewer
            </T>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

// ─── JSON ───────────────────────────────────────────────────────────────────

function JsonBody({
  text,
  fill,
  testID,
}: {
  text: string
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  // v1.3.4: theme-aware highlight (Pablo: JSON debe copiar el estilo del TXT
  // y solo diferenciarse por el highlight — oneDark en dark, oneLight en light).
  const syntaxTheme = useSyntaxTheme()
  let pretty = text
  let invalid = false
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    invalid = true // spec edge case: invalid JSON → monospace + notice
  }
  return (
    <View testID={testID} style={fill ? { flex: 1, padding: 12 } : { padding: 12, maxHeight: 320 }}>
      {invalid && (
        <T step="codenote" tone="text3" style={{ paddingBottom: 6 }}>
          JSON inválido — mostrando texto plano
        </T>
      )}
      <ScrollView>
        {invalid ? (
          <T step="code" selectable style={{ color: c.text2 }}>
            {text}
          </T>
        ) : (
          // v1.3.5: inline styles ON (removing them in v1.3.4 killed every
          // color — Pablo: "ha perdido todos los colores"). customStyle makes
          // the background transparent (inherits the card: white in light,
          // dark in dark — no grey film) and matches the TXT font (mono 12/16).
          <SyntaxHighlighter
            language="json"
            style={syntaxTheme}
            customStyle={{
              background: "transparent",
              margin: 0,
              padding: 0,
              fontFamily: FONT_MONO,
              fontSize: 12,
              lineHeight: "16px",
            }}
            codeTagProps={{
              style: { fontFamily: FONT_MONO, fontSize: 12, lineHeight: "16px" },
            }}
          >
            {pretty}
          </SyntaxHighlighter>
        )}
      </ScrollView>
    </View>
  )
}

// ─── PDF (OQ2: native embed on web, ~260px + fade) ──────────────────────────

function PdfBody({
  url,
  onFullscreen,
  fill,
  testID,
}: {
  url: string
  onFullscreen?: () => void
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  // v1.3.9: the narrow-viewport fallback row is GONE. The v1.3.4 diagnosis
  // ("mobile browsers don't render PDF iframes — blank embed") was
  // contaminated by the X-Frame-Options bug: Pablo verified on iPhone that
  // the inline iframe renders perfectly now that /media/ allows framing
  // (v1.3.7). One pattern at every width: strip + inline iframe.
  if (Platform.OS === "web") {
    // v1.3.0: fill (window context) → the iframe takes the full height;
    // the bubble keeps the ~260px preview + bottom fade (ux §3.2).
    return (
      <View
        testID={testID}
        style={fill ? { flex: 1 } : { position: "relative", height: 260 }}
      >
        <iframe
          src={url}
          title="PDF"
          style={{ width: "100%", height: "100%", border: "none", backgroundColor: c.nest }}
        />
        {/* Bottom fade hinting more content below (ux §3.2) — bubble only,
            in the window the iframe already fills everything */}
        {!fill && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 28,
              background: `linear-gradient(to bottom, transparent, ${c.bgStep})`,
              pointerEvents: "none",
            }}
          />
        )}
      </View>
    )
  }
  // Native: no inline PDF renderer in the MVP — quiet placeholder, actions still work
  return (
    <View
      testID={testID}
      style={{
        height: 120,
        backgroundColor: c.nest,
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      <Ph name="file-pdf" size={22} color={c.text3} />
      <T step="codenote" tone="text3">
        PDF — abrir en FileViewer
      </T>
    </View>
  )
}

// ─── Image (360-400px, click = fullscreen) ──────────────────────────────────

function ImageBody({
  url,
  filename,
  onFullscreen,
  fill,
  testID,
}: {
  url: string
  filename: string
  onFullscreen?: () => void
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  const [error, setError] = useState(false)
  const { width: screenWidth } = useWindowDimensions()
  const maxWidth = Math.min(screenWidth * 0.7, 400)
  // v1.3.0: in the window context the image fills the available height
  // (no 400px cap — the window IS the viewer).

  if (error) {
    return (
      <View
        testID={testID}
        style={{
          height: 120,
          backgroundColor: c.nest,
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <Ph name="image-broken" size={22} color={c.text3} />
        <T step="sm" tone="text3">
          Error loading image
        </T>
      </View>
    )
  }

  if (Platform.OS === "web") {
    return (
      <img
        data-testid={testID}
        src={url}
        alt={filename}
        onClick={onFullscreen}
        style={
          fill
            ? { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "100%", objectFit: "contain", display: "block", margin: "auto" }
            : { maxWidth, maxHeight: 400, objectFit: "contain", display: "block", cursor: onFullscreen ? "zoom-in" : "default" }
        }
        onError={() => setError(true)}
      />
    )
  }
  return (
    <Image
      testID={testID}
      source={{ uri: url }}
      style={{ width: maxWidth, height: 300, resizeMode: "contain" }}
      onError={() => setError(true)}
    />
  )
}

// ─── Audio / Video (reuse current player patterns) ──────────────────────────

function AudioBody({ url, testID }: { url: string; testID?: string }) {
  if (Platform.OS === "web") {
    // v1.3.4: padding lives on the WRAPPER, not the <audio> — inline padding
    // on a replaced element with width:100% overflows the card by 2×padding
    // on the right (Pablo: "se sale dos veces el margin por la derecha").
    return (
      <View style={{ padding: 12, minWidth: 0 }}>
        <audio
          data-testid={testID}
          src={url}
          controls
          style={{ width: "100%", display: "block" }}
        />
      </View>
    )
  }
  // Native: quiet placeholder (expo-av wiring is out of FVU MVP scope)
  return <View testID={testID} style={{ height: 48 }} />
}

function VideoBody({
  url,
  fill,
  testID,
}: {
  url: string
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  if (Platform.OS === "web") {
    // v1.3.0: fill (window) → the video takes the full window; the bubble
    // keeps the 400px cap (ux §3.2).
    return (
      <video
        data-testid={testID}
        src={url}
        controls
        style={
          fill
            ? {
                width: "100%",
                height: "100%",
                display: "block",
                backgroundColor: c.nest,
              }
            : {
                width: "100%",
                maxWidth: 400,
                display: "block",
                backgroundColor: c.nest,
              }
        }
      />
    )
  }
  return <View testID={testID} style={{ height: 200, backgroundColor: c.nest }} />
}

// ─── Text / Markdown ────────────────────────────────────────────────────────

function TextBody({
  text,
  fill,
  testID,
}: {
  text: string
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  return (
    <View testID={testID} style={fill ? { flex: 1, padding: 12 } : { padding: 12, maxHeight: 320 }}>
      <ScrollView>
        <T step="code" selectable style={{ color: c.text2 }}>
          {text}
        </T>
      </ScrollView>
    </View>
  )
}

// ─── HTML (sandboxed iframe — same construction as the previous viewer, NFR-3)

/** Responsive CSS injected into every rendered HTML file so content adapts
 *  to the width of its container (carried over verbatim from the previous
 *  FileViewerWindow — zero HTML regression, FVU-NFR-3). */
const RESPONSIVE_CSS = `
  html, body { max-width: 100% !important; overflow-x: auto !important; }
  table, div, section, article, main, header, footer, aside, nav,
  figure, figcaption, form, fieldset, pre, blockquote { max-width: 100% !important; }
  img, svg, video, canvas, iframe, embed, object { max-width: 100% !important; height: auto !important; }
  pre { overflow-x: auto !important; white-space: pre-wrap !important; word-wrap: break-word !important; }
  [data-teros-fixed-width] { max-width: none !important; }
`

/** Wrap raw HTML into a self-contained document with the responsive CSS. */
export function wrapHtml(content: string): string {
  if (/<!DOCTYPE|<html/i.test(content)) {
    const headMatch = content.match(/<head[^>]*>/i)
    if (headMatch) {
      const insertAt = headMatch.index! + headMatch[0].length
      return content.slice(0, insertAt) + `
  <style>${RESPONSIVE_CSS}</style>` + content.slice(insertAt)
    }
    const bodyMatch = content.match(/<body[^>]*>/i)
    if (bodyMatch) {
      const insertAt = bodyMatch.index! + bodyMatch[0].length
      return content.slice(0, insertAt) + `
  <style>${RESPONSIVE_CSS}</style>` + content.slice(insertAt)
    }
    return `<style>${RESPONSIVE_CSS}</style>` + content
  }
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #ffffff; overflow: auto; min-height: 100%; }
    ${RESPONSIVE_CSS}
  </style>
</head>
<body>
${content}
</body>
</html>`
}

/** HTML body: full-bleed sandboxed iframe (web) / WebView (native), height
 *  driven by the parent (bubble caps it; the viewer gives it flex 1). */
export function HtmlBody({
  textContent,
  height,
  fill,
  testID,
}: {
  textContent: string
  height?: number
  fill?: boolean
  testID?: string
}) {
  const c = useColors()
  const doc = useMemo(() => wrapHtml(textContent), [textContent])
  if (Platform.OS === "web") {
    return (
      <iframe
        data-testid={testID}
        srcDoc={doc}
        sandbox="allow-scripts"
        title="HTML"
        style={{
          width: "100%",
          height: fill ? "100%" : (height ?? 400),
          border: "none",
          display: "block",
          backgroundColor: "#ffffff",
        }}
      />
    )
  }
  return (
    <WebView
      testID={testID}
      source={{ html: doc }}
      style={{
        width: "100%",
        height: fill ? "100%" : (height ?? 400),
        backgroundColor: c.nest,
      }}
      originWhitelist={["*"]}
      scrollEnabled
      javaScriptEnabled
    />
  )
}

// ─── Fallback (a valid state, never an error — FVU-REQ-5) ───────────────────

function FallbackBody({
  kind,
  filename,
  size,
  url,
  testID,
}: {
  kind: FileRenderKind
  filename: string
  size?: number
  url: string
  testID?: string
}) {
  const c = useColors()
  // v1.3.5 (Pablo Round 2): one row, no strip — type icon + name + size on
  // the left, EXPLICIT action buttons on the right. The icon-tile-as-button
  // from v1.3.4 was not discoverable (Pablo could not find the download).
  // ZIP → Download only. PDF reaches this row only when OVERSIZED (>10MB,
  // isInlineRenderable guard) → Download + Abrir (new tab). v1.3.9 removed
  // the narrow-viewport pdf case — the "blank iframe on mobile" was the
  // X-Frame-Options bug, not iOS.
  const isPdf = kind === "pdf"
  const handleDownload = () => {
    if (Platform.OS !== "web") return
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.rel = "noopener"
    a.click()
  }
  const handleNewTab = () => {
    if (Platform.OS !== "web") return
    window.open(url, "_blank", "noopener")
  }
  const btn = (label: string, icon: string, onPress: () => void, tid: string, primary = false) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${filename}`}
      testID={tid}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: primary ? c.borderAccent : c.border,
        backgroundColor: primary ? c.navActive : "transparent",
        flexShrink: 0,
      }}
    >
      <Ph name={icon as any} size={14} color={primary ? c.accent : c.text2} />
      <T step="codenote" style={{ color: primary ? c.accent : c.text2, textTransform: "none" }}>
        {label}
      </T>
    </Pressable>
  )
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        backgroundColor: c.nest,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          backgroundColor: c.tile,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Ph name={kindIcon(kind, filename) as any} size={22} color={c.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" ellipsis selectable>
          {filename}
        </T>
        <T step="codenote" tone="text3">
          {[formatFileSize(size), kindLabel(kind, filename)].filter(Boolean).join(" · ")}
        </T>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {btn("Descargar", "download-simple", handleDownload, `${testID}-download`, true)}
        {isPdf && btn("Abrir", "arrow-square-out", handleNewTab, `${testID}-newtab`)}
      </View>
    </View>
  )
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export function FileTypeBody({
  kind,
  filename,
  url,
  textContent,
  size,
  onFullscreen,
  fill,
  testID = "ft-body",
}: FileTypeBodyProps) {
  const c = useColors()

  // Size guard: oversized files never go inline (edge case) — fallback body.
  if (!isInlineRenderable(kind, size)) {
    return <FallbackBody kind={kind} filename={filename} size={size} url={url} testID={`${testID}-fallback`} />
  }

  // v1.3.0: in the window context (fill) the body takes the available
  // height and the inline caps are dropped — the parent scrolls.
  const capStyle = fill ? { flex: 1 } : { maxHeight: 400 }

  switch (kind) {
    case "markdown":
      return textContent != null ? (
        // v1.3.3 mobile fix: overflow hidden + minWidth 0 clamp the body to
        // the bubble width — wide tables/code scroll INSIDE (the .md-content
        // table rule has overflow:auto) instead of stretching the bubble past
        // the window edge (Bug 1, Pablo 2026-10-16).
        <View
          testID={`${testID}-md`}
          style={[capStyle, { overflow: "hidden", minWidth: 0, alignSelf: "stretch", width: "100%" }]}
        >
          <MarkdownRenderer content={textContent} />
        </View>
      ) : (
        <View style={{ padding: 16, alignItems: "center" }}>
          <T step="sm" tone="text3">
            …
          </T>
        </View>
      )
    case "image":
      return (
        <ImageBody
          url={url}
          filename={filename}
          onFullscreen={onFullscreen}
          fill={fill}
          testID={`${testID}-image`}
        />
      )
    case "pdf":
      return (
        <PdfBody
          url={url}
          onFullscreen={onFullscreen}
          fill={fill}
          testID={`${testID}-pdf`}
        />
      )
    case "audio":
      return <AudioBody url={url} testID={`${testID}-audio`} />
    case "video":
      return <VideoBody url={url} fill={fill} testID={`${testID}-video`} />
    case "csv":
      return textContent != null ? (
        <CsvTable text={textContent} fill={fill} testID={`${testID}-csv`} />
      ) : null
    case "json":
      return textContent != null ? (
        <JsonBody text={textContent} fill={fill} testID={`${testID}-json`} />
      ) : null
    case "text":
      return textContent != null ? (
        <TextBody text={textContent} fill={fill} testID={`${testID}-text`} />
      ) : null
    case "html":
      // HTML renders through the same sandboxed iframe construction the
      // previous viewer used (NFR-3 — zero HTML regression).
      return textContent != null ? (
        <HtmlBody textContent={textContent} fill={fill} testID={`${testID}-html`} />
      ) : null
    default:
      return <FallbackBody kind={kind} filename={filename} size={size} url={url} testID={`${testID}-fallback`} />
  }
}
