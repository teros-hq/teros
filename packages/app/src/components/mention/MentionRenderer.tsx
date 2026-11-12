/**
 * MentionRenderer
 *
 * Custom renderer for `teros://` links inside Markdown-rendered chat messages.
 *
 * When `react-native-render-html` encounters an `<a>` tag whose `href` starts
 * with `teros://`, instead of rendering a plain hyperlink it renders an inline
 * pill/chip that matches the visual style of `MentionChip` in the composer
 * (the OS prototype's active `.chipbtn`: nav-active wash, accent text,
 * Phosphor glyph, weight 400 — light + dark via `useMentionColors()`).
 *
 * URL schema: `teros://{type}/{id}`
 * Supported types: agent | project | app | skill | conversation | workspace
 *
 * On click (web) the chip calls `onMentionPress` if provided, which can open
 * the relevant resource window.
 */

import React, { useState } from "react"
import { Platform } from "react-native"
import type { MentionResourceType } from "../../hooks/useAtMention"
import { useImageWithFallback } from "../../hooks/useImageWithFallback"
import { FONT_SANS } from "../mca/primitives/fonts"
import type { AdaptiveColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds"
import { useMentionColors } from "./useMentionColors"

// ── Design tokens (mirrors MentionChip.tsx) ───────────────────────────────────

const CHIP_BORDER_RADIUS = 100
const CHIP_HEIGHT = 24
const CHIP_FONT_SIZE = 12
const CHIP_FONT_WEIGHT = 400
const CHIP_PADDING_LEFT = 7
const CHIP_PADDING_RIGHT = 9
const CHIP_GAP = 5
const ICON_SIZE = 13
const FONT_FAMILY = `${FONT_SANS}, system-ui, sans-serif`

// ── Phosphor glyph per resource type ──────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  agent: "user",
  project: "kanban",
  conversation: "chat-circle",
  app: "cube",
  skill: "lightning",
  workspace: "buildings",
  file: "file",
}

const FALLBACK_ICON = TYPE_ICON["agent"]

// Keep a simple emoji fallback for the native renderer
const TYPE_ICON_NATIVE: Record<string, string> = {
  agent: "👤",
  project: "📋",
  app: "📦",
  skill: "📖",
  conversation: "💬",
  workspace: "🏠",
}

// ── Teros URL parser ──────────────────────────────────────────────────────────

export interface ParsedTerosUrl {
  type: MentionResourceType
  id: string
}

/**
 * Parses a `teros://{type}/{id}` URL.
 * Returns null if the URL doesn't match the schema.
 */
export function parseTerosUrl(href: string): ParsedTerosUrl | null {
  if (!href.startsWith("teros://")) return null
  const rest = href.slice("teros://".length) // e.g. "agent/agent_abc123"
  const slashIdx = rest.indexOf("/")
  if (slashIdx === -1) return null
  const type = rest.slice(0, slashIdx) as MentionResourceType
  const id = rest.slice(slashIdx + 1)
  if (!type || !id) return null
  return { type, id }
}

// ── Agent avatar helper ───────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

interface AgentAvatarProps {
  name: string
  avatarUrl?: string
  c: AdaptiveColors
}

function AgentAvatar({ name, avatarUrl, c }: AgentAvatarProps) {
  const { showImage, onError } = useImageWithFallback(avatarUrl)
  if (showImage) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{
          width: ICON_SIZE + 1,
          height: ICON_SIZE + 1,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
        }}
        onError={onError}
      />
    )
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: ICON_SIZE + 1,
        height: ICON_SIZE + 1,
        borderRadius: "50%",
        backgroundColor: c.tint.m.bg,
        color: c.tint.m.tx,
        fontSize: 7,
        fontWeight: 400,
        flexShrink: 0,
        lineHeight: 1,
        fontFamily: FONT_FAMILY,
      }}
    >
      {getInitials(name)}
    </span>
  )
}

// ── Inline chip (web-only, rendered via react-native-render-html custom renderer) ──

interface MentionChipInlineProps {
  name: string
  type: MentionResourceType
  id: string
  avatarUrl?: string
  onPress?: (type: MentionResourceType, id: string) => void
}

/**
 * Inline chip rendered inside a chat message for `teros://` links.
 * Web-only — uses plain HTML elements for inline rendering within RenderHtml.
 */
export function MentionChipInline({ name, type, id, avatarUrl, onPress }: MentionChipInlineProps) {
  const c = useMentionColors()
  const [hovered, setHovered] = useState(false)
  const icon = TYPE_ICON[type] ?? FALLBACK_ICON

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onPress?.(type, id)
  }

  return (
    <span
      onClick={onPress ? handleClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${type}: ${name} [${id}]`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: CHIP_GAP,
        paddingLeft: CHIP_PADDING_LEFT,
        paddingRight: CHIP_PADDING_RIGHT,
        height: CHIP_HEIGHT,
        borderRadius: CHIP_BORDER_RADIUS,
        backgroundColor: hovered && onPress ? c.tint.i.bg : c.navActive,
        border: "1px solid transparent",
        fontSize: CHIP_FONT_SIZE,
        fontWeight: CHIP_FONT_WEIGHT,
        fontFamily: FONT_FAMILY,
        color: c.accent,
        cursor: onPress ? "pointer" : "default",
        userSelect: "none",
        whiteSpace: "nowrap",
        maxWidth: 220,
        verticalAlign: "middle",
        lineHeight: `${CHIP_HEIGHT - 2}px`,
        transition: "background-color 0.2s",
        textDecoration: "none",
        boxSizing: "border-box",
      }}
    >
      {/* Icon / Avatar */}
      {type === "agent" ? (
        <AgentAvatar name={name} avatarUrl={avatarUrl} c={c} />
      ) : (
        <Ph name={icon} size={ICON_SIZE} color={c.accent} />
      )}

      {/* Name */}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 160,
        }}
      >
        {name}
      </span>
    </span>
  )
}

// ── react-native-render-html custom anchor renderer ───────────────────────────

/**
 * Custom renderer for `<a>` tags in react-native-render-html.
 *
 * If the href is a `teros://` URL, renders a `MentionChipInline`.
 * Otherwise falls back to the default link rendering (returns undefined).
 *
 * Usage:
 * ```tsx
 * import { buildMentionAnchorRenderer } from './MentionRenderer';
 *
 * const renderers = {
 *   a: buildMentionAnchorRenderer(onMentionPress),
 * };
 * ```
 */
export function buildMentionAnchorRenderer(
  onMentionPress?: (type: MentionResourceType, id: string) => void,
) {
  // react-native-render-html passes { tnode, TDefaultRenderer, ...rest }
  return function MentionAnchorRenderer({ tnode, TDefaultRenderer, ...rest }: any) {
    const c = useMentionColors()
    const href: string = tnode?.attributes?.href ?? ""
    const parsed = parseTerosUrl(href)

    if (!parsed) {
      // Not a teros:// link — render normally
      return <TDefaultRenderer tnode={tnode} {...rest} />
    }

    // Extract the display name from the link text content
    const name = extractTnodeText(tnode) || parsed.id

    if (Platform.OS === "web") {
      // On web: render inline HTML chip
      return (
        <MentionChipInline name={name} type={parsed.type} id={parsed.id} onPress={onMentionPress} />
      )
    }

    // On native: render as styled text (chips are harder inline on native)
    const nativeIcon = TYPE_ICON_NATIVE[parsed.type] ?? "📌"
    return (
      <TDefaultRenderer
        tnode={tnode}
        {...rest}
        style={{
          color: c.accent,
          backgroundColor: c.navActive,
          borderRadius: 6,
          paddingHorizontal: 5,
          overflow: "hidden",
        }}
      >
        {nativeIcon} {name}
      </TDefaultRenderer>
    )
  }
}

// ── Utility: extract text from a tnode tree ───────────────────────────────────

function extractTnodeText(tnode: any): string {
  if (!tnode) return ""
  if (tnode.type === "text") return tnode.data ?? ""
  if (tnode.children?.length) {
    return tnode.children.map(extractTnodeText).join("")
  }
  // react-native-render-html v6 stores children in domNode
  if (tnode.domNode) {
    return extractDomText(tnode.domNode)
  }
  return ""
}

function extractDomText(node: any): string {
  if (!node) return ""
  if (node.type === "text") return node.data ?? ""
  if (node.children?.length) {
    return node.children.map(extractDomText).join("")
  }
  return ""
}
