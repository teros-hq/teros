/**
 * Figma-specific data helpers.
 *
 * Pure functions over the Figma REST API shapes. Used by the per-tool
 * handlers to build curated responses (no I/O here — figma-client owns
 * the network layer).
 */

// ============================================================================
// UPSTREAM TYPES (subset — only what we touch)
// ============================================================================

export interface FigmaColor {
  r: number
  g: number
  b: number
  a?: number
}

export interface FigmaPaint {
  type: string
  color?: FigmaColor
  opacity?: number
}

export interface FigmaTypeStyle {
  fontFamily: string
  fontWeight: number
  fontSize: number
  letterSpacing?: number
  lineHeightPx?: number
}

export interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  style?: FigmaTypeStyle
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number }
  cornerRadius?: number
  strokeWeight?: number
  effects?: unknown[]
  componentId?: string
  componentSetId?: string
}

export interface FigmaFile {
  name: string
  lastModified: string
  thumbnailUrl: string
  version: string
  document: FigmaNode
  components: Record<string, unknown>
  componentSets: Record<string, unknown>
  styles: Record<string, unknown>
  role?: string
  editorType?: string
}

// ============================================================================
// COLOR CONVERSION
// ============================================================================

export function rgbaToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255)
  const g = Math.round(color.g * 255)
  const b = Math.round(color.b * 255)
  const a = color.a ?? 1

  if (a < 1) {
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

// ============================================================================
// NODE SIMPLIFICATION
// ============================================================================

export interface SimplifiedNode {
  id: string
  name: string
  type: string
  bounds?: { width: number; height: number }
  fills?: Array<{ type: string; color?: string }>
  strokes?: Array<{ type: string; color?: string }>
  strokeWeight?: number
  cornerRadius?: number
  textStyle?: {
    fontFamily: string
    fontSize: number
    fontWeight: number
    lineHeight?: number
    letterSpacing?: number
  }
  componentId?: string
  componentSetId?: string
  children?: SimplifiedNode[]
  childCount?: number
}

/**
 * Recursively simplify a Figma node tree, keeping only the fields the LLM
 * and renderer need. Stops descending past `depth` levels and reports the
 * remaining child count instead.
 */
export function simplifyNode(node: FigmaNode, depth: number, currentDepth = 0): SimplifiedNode {
  const out: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  }

  if (node.absoluteBoundingBox) {
    out.bounds = {
      width: Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    }
  }

  if (node.fills?.length) {
    out.fills = node.fills
      .filter((f) => f.type !== "IMAGE")
      .map((f) => ({
        type: f.type,
        color: f.color ? rgbaToHex(f.color) : undefined,
      }))
  }

  if (node.strokes?.length) {
    out.strokes = node.strokes.map((s) => ({
      type: s.type,
      color: s.color ? rgbaToHex(s.color) : undefined,
    }))
    if (node.strokeWeight) out.strokeWeight = node.strokeWeight
  }

  if (node.cornerRadius) out.cornerRadius = node.cornerRadius

  if (node.style) {
    out.textStyle = {
      fontFamily: node.style.fontFamily,
      fontSize: node.style.fontSize,
      fontWeight: node.style.fontWeight,
      lineHeight: node.style.lineHeightPx,
      letterSpacing: node.style.letterSpacing,
    }
  }

  if (node.componentId) out.componentId = node.componentId
  if (node.componentSetId) out.componentSetId = node.componentSetId

  if (node.children && currentDepth < depth) {
    out.children = node.children.map((child) => simplifyNode(child, depth, currentDepth + 1))
  } else if (node.children) {
    out.childCount = node.children.length
  }

  return out
}

// ============================================================================
// EXTRACTORS (extract-colors, extract-typography)
// ============================================================================

export function extractColorsFromNode(node: FigmaNode, colors: Map<string, FigmaColor>): void {
  for (const fill of node.fills ?? []) {
    if (fill.color && fill.type === "SOLID") {
      const hex = rgbaToHex(fill.color)
      if (!colors.has(hex)) colors.set(hex, fill.color)
    }
  }
  for (const stroke of node.strokes ?? []) {
    if (stroke.color && stroke.type === "SOLID") {
      const hex = rgbaToHex(stroke.color)
      if (!colors.has(hex)) colors.set(hex, stroke.color)
    }
  }
  for (const child of node.children ?? []) {
    extractColorsFromNode(child, colors)
  }
}

export function extractTypographyFromNode(
  node: FigmaNode,
  styles: Map<string, FigmaTypeStyle>,
): void {
  if (node.style && node.type === "TEXT") {
    const key = `${node.style.fontFamily}-${node.style.fontSize}-${node.style.fontWeight}`
    if (!styles.has(key)) styles.set(key, node.style)
  }
  for (const child of node.children ?? []) {
    extractTypographyFromNode(child, styles)
  }
}

// ============================================================================
// FORMATTERS (CSS / Tailwind / JSON)
// ============================================================================

export function formatColorsAsCss(colors: string[]): string {
  const cssVars = colors.map((hex, i) => `  --color-${i + 1}: ${hex};`).join("\n")
  return `:root {\n${cssVars}\n}`
}

export function formatColorsAsTailwind(colors: string[]): string {
  const entries = colors.map((hex, i) => `  "color-${i + 1}": "${hex}"`).join(",\n")
  return `// tailwind.config.js colors\n{\n${entries}\n}`
}

export function formatTypographyAsCss(styles: FigmaTypeStyle[]): string {
  return styles
    .map((style, i) => {
      const lines = [
        `  font-family: "${style.fontFamily}";`,
        `  font-size: ${style.fontSize}px;`,
        `  font-weight: ${style.fontWeight};`,
      ]
      if (style.lineHeightPx) lines.push(`  line-height: ${style.lineHeightPx}px;`)
      if (style.letterSpacing) lines.push(`  letter-spacing: ${style.letterSpacing}px;`)
      return `.text-style-${i + 1} {\n${lines.join("\n")}\n}`
    })
    .join("\n\n")
}

export function formatTypographyAsTailwind(styles: FigmaTypeStyle[]): string {
  const entries = styles
    .map((style, i) => {
      const lh = style.lineHeightPx ?? Math.round(style.fontSize * 1.5)
      return `"text-${i + 1}": ["${style.fontSize}px", { lineHeight: "${lh}px", fontWeight: "${style.fontWeight}" }]`
    })
    .join(",\n  ")
  return `// tailwind.config.js fontSize\n{\n  ${entries}\n}`
}
