/**
 * Figma — constants, types, helpers, and a compose-only `FigmaToolShell`.
 *
 * Mirrors `linear/shared.tsx` (TER-281 zero-local-components pattern). What
 * lives here:
 *
 *  - Constants: official Figma brand palette + node/style type colour maps + logo url.
 *  - Types tolerant to the curated `simplifyNode` shape and the upstream raw shape.
 *  - Shape-agnostic getters (`getNodeName`, `getNodeChildren`, …).
 *  - Prop factories that feed the global primitives:
 *      `nodeTypeChipProps(type) → IconChipProps`
 *      `styleTypeChipProps(type)`, `variableTypeChipProps(type)`,
 *      `paintSwatchTileProps(paint)`, `nodeTileProps(node)`.
 *  - `FigmaToolShell` — compose-only wrapper over `ToolCallCard` that
 *    pre-fills `iconUri={FIGMA_ICON}` and the description label.
 */

import {
  Component,
  Frame,
  Hash,
  Layers,
  Palette,
  Square,
  ToggleLeft,
  Type,
} from '../../primitives'
import type React from "react"
import { Text } from "tamagui"
import { Badge, ToolCallCard, useColors } from "../../primitives"
import type { ToolCallRendererProps } from "../../types"

// ============================================================================
// Constants
// ============================================================================

export const FIGMA_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.figma/icon.png`

/**
 * Figma's official brand palette — the five colours of the toolbar. Used as
 * accents across the renderer so a Figma tool call is visually unmistakable.
 *
 * IMPORTANT: do NOT substitute Tailwind defaults. The vendor's canonical
 * palette is published in their press kit and embedded in the official SVG
 * logo (downloaded from Wikimedia Commons).
 */
export const FIGMA_PALETTE = {
  red: "#F24E1E", // VECTOR / RECTANGLE / ELLIPSE
  orange: "#FF7262", // INSTANCE
  purple: "#A259FF", // FRAME / GROUP
  green: "#0ACF83", // COMPONENT / COMPONENT_SET
  blue: "#1ABCFE", // TEXT
} as const

/** Map the upstream node `type` field to a brand-palette accent. */
export const NODE_TYPE_COLOR: Record<string, string> = {
  FRAME: FIGMA_PALETTE.purple,
  GROUP: FIGMA_PALETTE.purple,
  SECTION: FIGMA_PALETTE.purple,
  COMPONENT: FIGMA_PALETTE.green,
  COMPONENT_SET: FIGMA_PALETTE.green,
  INSTANCE: FIGMA_PALETTE.orange,
  TEXT: FIGMA_PALETTE.blue,
  VECTOR: FIGMA_PALETTE.red,
  RECTANGLE: FIGMA_PALETTE.red,
  ELLIPSE: FIGMA_PALETTE.red,
  LINE: FIGMA_PALETTE.red,
  STAR: FIGMA_PALETTE.red,
  POLYGON: FIGMA_PALETTE.red,
}

export const STYLE_TYPE_COLOR: Record<string, string> = {
  FILL: FIGMA_PALETTE.red,
  TEXT: FIGMA_PALETTE.blue,
  EFFECT: FIGMA_PALETTE.purple,
  GRID: FIGMA_PALETTE.green,
}

export const VARIABLE_TYPE_COLOR: Record<string, string> = {
  COLOR: FIGMA_PALETTE.red,
  FLOAT: FIGMA_PALETTE.blue,
  STRING: FIGMA_PALETTE.purple,
  BOOLEAN: FIGMA_PALETTE.green,
}

/**
 * Style for `<ScrollView style={SCROLL_STYLE(maxH)}/>` inside a tool-call
 * body. On web, opts-in to the thin dark scrollbar; on native it is ignored.
 *
 * Uses the theme-adaptive `text3` token for the scrollbar thumb so it remains
 * subtle in both light and dark modes.
 */
// biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
export function scrollStyle(maxHeight: number): any {
  const c = useColors()
  return {
    maxHeight,
    scrollbarWidth: "thin",
    scrollbarColor: `${c.text3} transparent`,
  }
}

// ============================================================================
// Types (tolerant to curated `simplifyNode` and legacy upstream shapes)
// ============================================================================

export interface FigmaPaintColor {
  r: number
  g: number
  b: number
  a?: number
}

export interface FigmaPaint {
  type: string
  color?: FigmaPaintColor | string // upstream raw is RGBA, curated is hex
  opacity?: number
}

export interface FigmaTextStyle {
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight?: number
  letterSpacing?: number
}

export interface FigmaSimplifiedNode {
  id: string
  name: string
  type: string
  bounds?: { width: number; height: number }
  fills?: Array<{ type: string; color?: string }>
  strokes?: Array<{ type: string; color?: string }>
  strokeWeight?: number
  cornerRadius?: number
  textStyle?: FigmaTextStyle
  componentId?: string
  componentSetId?: string
  children?: FigmaSimplifiedNode[]
  childCount?: number
}

export interface FigmaFileSummary {
  name: string
  lastModified: string
  version: string
  thumbnailUrl?: string
  document: FigmaSimplifiedNode
  componentCount: number
  styleCount: number
  role?: string
  editorType?: string
}

export interface FigmaComponentRef {
  id: string
  key: string
  name: string
  description?: string
  componentSetId?: string | null
}

export interface FigmaComponentSetRef {
  id: string
  key: string
  name: string
  description?: string
}

export interface FigmaStyleRef {
  id: string
  key: string
  name: string
  type: string
  description?: string
}

export interface FigmaVariable {
  id: string
  name: string
  type: string
  values: Record<string, unknown>
  description?: string
}

export interface FigmaVariableCollection {
  id: string
  name: string
  modes: Array<{ modeId: string; name: string }>
  variables: FigmaVariable[]
  defaultModeId?: string
}

export interface FigmaComment {
  id: string
  message: string
  createdAt: string
  user?: string | { handle?: string } // tolerate string (curated) and legacy {handle}
  resolved: boolean
  parentId?: string
  clientMeta?: { x?: number; y?: number; node_id?: string }
}

export interface FigmaVersion {
  id: string
  createdAt: string
  label?: string
  description?: string
  user?: string | { handle?: string }
  thumbnailUrl?: string
}

export interface FigmaExportedImage {
  nodeId: string
  url: string
  format: string
  scale: number
}

export interface FigmaExtractResult {
  count: number
  output: string
  format?: string
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  "-health-check": "Health check",
  "get-file": "File overview",
  "get-node": "Node details",
  "get-file-styles": "File styles",
  "get-file-variables": "Design tokens",
  "get-components": "Components",
  "get-component-sets": "Component variants",
  "export-images": "Export images",
  "get-comments": "Comments",
  "create-comment": "Create comment",
  "delete-comment": "Delete comment",
  "list-file-versions": "Version history",
  "extract-colors": "Extract colors",
  "extract-typography": "Extract typography",
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split("_")
  return parts[parts.length - 1] || toolName
}

function humanize(name: string): string {
  const cleaned = name.replace(/^-/, "")
  const joined = cleaned.replace(/-/g, " ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName)
  return TOOL_LABELS[short] ?? humanize(short)
}

// ============================================================================
// Shape-agnostic getters
// ============================================================================

export function getNodeName(n: Partial<FigmaSimplifiedNode> | undefined | null): string {
  if (!n) return "(unnamed)"
  return n.name?.trim() || "(unnamed)"
}

export function getNodeType(n: Partial<FigmaSimplifiedNode> | undefined | null): string {
  if (!n) return "NODE"
  return (n.type ?? "NODE").toUpperCase()
}

export function getNodeChildren(
  n: Partial<FigmaSimplifiedNode> | undefined | null,
): FigmaSimplifiedNode[] {
  if (!n?.children) return []
  return n.children
}

export function getNodeColor(n: Partial<FigmaSimplifiedNode> | undefined | null): string {
  const c = useColors()
  return NODE_TYPE_COLOR[getNodeType(n)] ?? c.text3
}

export function getNodeBoundingBoxLabel(
  n: Partial<FigmaSimplifiedNode> | undefined | null,
): string | null {
  if (!n?.bounds) return null
  return `${n.bounds.width}×${n.bounds.height}`
}

export function getCommentAuthor(c: FigmaComment | { user?: unknown }): string {
  const u = (c as FigmaComment).user
  if (typeof u === "string" && u) return u
  if (u && typeof u === "object" && "handle" in u && typeof u.handle === "string") return u.handle
  return "—"
}

export function getVersionAuthor(v: FigmaVersion): string {
  const u = v.user
  if (typeof u === "string" && u) return u
  if (u && typeof u === "object" && "handle" in u && typeof u.handle === "string") return u.handle
  return "—"
}

export function rgbToHex({ r, g, b, a }: FigmaPaintColor): string {
  const R = Math.round(r * 255)
  const G = Math.round(g * 255)
  const B = Math.round(b * 255)
  if (a !== undefined && a < 1) return `rgba(${R}, ${G}, ${B}, ${a.toFixed(2)})`
  return `#${R.toString(16).padStart(2, "0")}${G.toString(16).padStart(2, "0")}${B.toString(16).padStart(2, "0")}`
}

export function paintToHex(p: FigmaPaint): string | null {
  if (!p.color) return null
  if (typeof p.color === "string") return p.color
  return rgbToHex(p.color)
}

// ============================================================================
// Prop factories — feed global primitives, no JSX returned
// ============================================================================

export function nodeTypeChipProps(
  type: string | undefined,
): { icon: React.ReactNode; accent: string; text: string } | null {
  if (!type) return null
  const c = useColors()
  const upper = type.toUpperCase()
  const accent = NODE_TYPE_COLOR[upper] ?? c.text3
  const Icon = pickNodeIcon(upper)
  return {
    icon: <Icon size={9} color={accent} />,
    accent,
    text: upper,
  }
}

function pickNodeIcon(type: string) {
  if (type === "TEXT") return Type
  if (type === "COMPONENT" || type === "COMPONENT_SET") return Component
  if (type === "INSTANCE") return Layers
  if (type === "FRAME" || type === "GROUP" || type === "SECTION") return Frame
  return Square
}

export function styleTypeChipProps(type: string | undefined): { accent: string; text: string } {
  const c = useColors()
  if (!type) return { accent: c.text3, text: "STYLE" }
  const upper = type.toUpperCase()
  return { accent: STYLE_TYPE_COLOR[upper] ?? c.text3, text: upper }
}

export function variableTypeChipProps(type: string | undefined): {
  icon: React.ReactNode
  accent: string
  text: string
} {
  const c = useColors()
  const upper = (type ?? "").toUpperCase()
  const accent = VARIABLE_TYPE_COLOR[upper] ?? c.text3
  const Icon =
    upper === "COLOR" ? Palette : upper === "FLOAT" ? Hash : upper === "BOOLEAN" ? ToggleLeft : Type
  return { icon: <Icon size={9} color={accent} />, accent, text: upper || "TOKEN" }
}

export function paintSwatchTileProps(p: FigmaPaint): { accent: string; label: string } | null {
  const hex = paintToHex(p)
  if (!hex) return null
  return { accent: hex, label: "" }
}

export function nodeTileProps(n: Partial<FigmaSimplifiedNode>): { accent: string; label: string } {
  const accent = getNodeColor(n)
  const name = getNodeName(n)
  const label = (name === "(unnamed)" ? "?" : name[0] || "?").toUpperCase()
  return { accent, label }
}

// ============================================================================
// Generic helpers
// ============================================================================

export function formatDate(iso?: string | null): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`
  } catch {
    return iso
  }
}

export function shortId(id: string | undefined | null, head = 8, tail = 4): string {
  if (!id) return "—"
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

export function truncate(s: string | undefined | null, max: number): string {
  if (!s) return ""
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

export function unwrap<T extends object>(
  parsed: unknown,
  wrapperKey: string,
  identifierField: keyof T,
): T | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const wrapped = obj[wrapperKey]
  if (wrapped && typeof wrapped === "object" && (identifierField as string) in wrapped) {
    return wrapped as T
  }
  if ((identifierField as string) in obj) return obj as T
  return null
}

export function unwrapList<T>(
  parsed: unknown,
  wrapperKey: string,
): { items: T[]; count?: number; nextPage?: string | null } {
  if (!parsed) return { items: [] }
  if (Array.isArray(parsed)) return { items: parsed as T[] }
  if (typeof parsed !== "object") return { items: [] }
  const obj = parsed as Record<string, unknown>
  const list = obj[wrapperKey]
  const items = Array.isArray(list) ? (list as T[]) : []
  const count = typeof obj.count === "number" ? (obj.count as number) : items.length
  const nextPage = typeof obj.nextPage === "string" ? (obj.nextPage as string) : null
  return { items, count, nextPage }
}

/**
 * Adapts the parent's ToolCallRendererProps status to the primitives'
 * McaStatusType (which has no `pending` value).
 */
export function toolStatusForPrimitive(
  status: ToolCallRendererProps["status"],
): Exclude<ToolCallRendererProps["status"], "pending"> {
  if (status === "pending") return "running"
  return status
}

export function statusBadge(status: ToolCallRendererProps["status"]): React.ReactNode {
  if (status === "completed") return <Badge text="done" variant="success" />
  if (status === "failed") return <Badge text="failed" variant="error" />
  if (status === "pending_permission") return <Badge text="awaiting" variant="warning" />
  if (status === "running" || status === "pending") return <Badge text="running" variant="info" />
  return null
}

/**
 * Inline JSX helper to render a node ID with monospace + Figma red emphasis.
 */
export function nodeIdText(id: string | null | undefined): React.ReactNode {
  if (!id) return null
  return (
    <Text color={FIGMA_PALETTE.red} fontSize={9} fontFamily="$mono" fontWeight="600">
      {id}
    </Text>
  )
}

// ============================================================================
// FigmaToolShell — compose-only wrapper
// ============================================================================

interface FigmaToolShellProps {
  toolName: string
  status: ToolCallRendererProps["status"]
  duration?: number
  description?: string
  children?: React.ReactNode
  defaultExpanded?: boolean
  badge?: React.ReactNode
}

/**
 * Pre-fills `iconUri={FIGMA_ICON}`, the description label, and the status
 * badge on top of the global `<ToolCallCard/>`. No new styling.
 */
export function FigmaToolShell({
  toolName,
  status,
  duration,
  description,
  children,
  defaultExpanded,
  badge,
}: FigmaToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      verb={getToolLabel(toolName)}
      iconUri={FIGMA_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  )
}
