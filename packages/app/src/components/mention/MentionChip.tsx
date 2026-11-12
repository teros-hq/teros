/**
 * MentionChip
 *
 * A pill/chip component that represents a @mentioned resource inside the
 * InputComposer. Renders inline with the text and has a remove (×) button.
 *
 * Look: the OS prototype's active `.chipbtn` — a 400-weight pill on the
 * nav-active wash, accent text, Phosphor glyph (or the agent's avatar),
 * a quiet round × on the right. Light + dark via `useMentionColors()`.
 */

import React, { useState } from "react"
import type { MentionChip as MentionChipType } from "../../hooks/useAtMention"
import { useImageWithFallback } from "../../hooks/useImageWithFallback"
import { FONT_SANS } from "../mca/primitives/fonts"
import type { AdaptiveColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds"
import { useMentionColors } from "./useMentionColors"

// ── Design tokens ─────────────────────────────────────────────────────────────

const CHIP_BORDER_RADIUS = 100
const CHIP_HEIGHT = 24
const CHIP_FONT_SIZE = 12
const CHIP_FONT_WEIGHT = 400
const CHIP_PADDING_LEFT = 7
const CHIP_PADDING_RIGHT = 5
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

// Fallback for unknown types
const FALLBACK_ICON = TYPE_ICON["agent"]

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
  // Fall back to initials when the image 404s instead of the broken-image glyph.
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

// ── Component ─────────────────────────────────────────────────────────────────

interface MentionChipProps {
  chip: MentionChipType
  onRemove: (chipId: string) => void
}

export function MentionChip({ chip, onRemove }: MentionChipProps) {
  const c = useMentionColors()
  const [hovered, setHovered] = useState(false)
  const [removeHovered, setRemoveHovered] = useState(false)
  const { resource } = chip
  const icon = TYPE_ICON[resource.type] ?? FALLBACK_ICON

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: CHIP_GAP,
        paddingLeft: CHIP_PADDING_LEFT,
        paddingRight: CHIP_PADDING_RIGHT,
        height: CHIP_HEIGHT,
        borderRadius: CHIP_BORDER_RADIUS,
        backgroundColor: hovered ? c.tint.i.bg : c.navActive,
        border: "1px solid transparent",
        fontSize: CHIP_FONT_SIZE,
        fontWeight: CHIP_FONT_WEIGHT,
        fontFamily: FONT_FAMILY,
        color: c.accent,
        cursor: "default",
        userSelect: "none",
        whiteSpace: "nowrap",
        maxWidth: 220,
        flexShrink: 0,
        verticalAlign: "middle",
        lineHeight: `${CHIP_HEIGHT - 2}px`,
        transition: "background-color 0.2s",
        boxSizing: "border-box",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${resource.type}: ${resource.name} [${resource.id}]`}
    >
      {/* Icon / Avatar */}
      {resource.type === "agent" ? (
        <AgentAvatar name={resource.name} avatarUrl={resource.avatarUrl} c={c} />
      ) : (
        <Ph name={icon} size={ICON_SIZE} color={c.accent} />
      )}

      {/* Name */}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 150,
        }}
      >
        {resource.name}
      </span>

      {/* Remove button */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onRemove(chip.id)
        }}
        onMouseEnter={() => setRemoveHovered(true)}
        onMouseLeave={() => setRemoveHovered(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: "none",
          background: removeHovered ? c.wash2 : "transparent",
          cursor: "pointer",
          padding: 0,
          color: c.accent,
          opacity: removeHovered ? 1 : 0.6,
          flexShrink: 0,
          marginLeft: 1,
          transition: "background-color 0.2s, opacity 0.2s",
        }}
        aria-label={`Remove mention of ${resource.name}`}
      >
        <Ph name="x" size={10} color={c.accent} weight="bold" />
      </button>
    </span>
  )
}
