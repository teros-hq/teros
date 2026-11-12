/**
 * MentionDropdown
 *
 * Renders the grouped @mention dropdown above the input composer.
 * Groups are shown in the order: Agentes, Proyectos, Apps, Skills,
 * Conversaciones, Ficheros, Workspaces.
 * Only groups with matching results are shown.
 *
 * Look: the OS prototype's `.menu` card — radius 16, one step off the
 * sheet, hairline border, raised shadow, 6px padding; `.msec` group
 * headers (codenote, text3); `.mi` rows (radius 10, wash on hover,
 * nav-active + accent when selected); Phosphor glyphs per resource type.
 * Light + dark via `useMentionColors()`.
 *
 * Positioning: position:absolute, bottom:100% of the nearest position:relative
 * ancestor (the InputComposer container). The container must have
 * position:relative set — InputComposer.web.tsx wraps everything in a <div>
 * with position:relative for exactly this reason.
 */

import React, { useEffect, useRef, useState } from "react"
import type { MentionGroup, MentionResource } from "../../hooks/useAtMention"
import { useImageWithFallback } from "../../hooks/useImageWithFallback"
import { FONT_MONO, FONT_SANS } from "../mca/primitives/fonts"
import type { AdaptiveColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds"
import { useMentionColors } from "./useMentionColors"

// ── Phosphor glyph per resource type ──────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  agent: "user",
  project: "kanban",
  app: "cube",
  skill: "lightning",
  conversation: "chat-circle",
  file: "file",
  workspace: "buildings",
}

const FALLBACK_ICON = "at"

// ── Shared style constants ────────────────────────────────────────────────────

const FONT_FAMILY = `${FONT_SANS}, system-ui, sans-serif`
const MONO_FAMILY = `${FONT_MONO}, ui-monospace, monospace`

// ── Avatar sub-component (needs its own hook state per item) ───────────────────

function DropdownAvatar({
  avatarUrl,
  name,
  type,
  c,
  selected,
}: {
  avatarUrl?: string
  name: string
  type: string
  c: AdaptiveColors
  selected: boolean
}) {
  const { showImage, onError } = useImageWithFallback(avatarUrl)
  if (showImage) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
          border: `1px solid ${c.border}`,
        }}
        onError={onError}
      />
    )
  }
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        backgroundColor: selected ? c.navActive : c.tile,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Ph name={TYPE_ICON[type] ?? FALLBACK_ICON} size={14} color={selected ? c.accent : c.text2} />
    </div>
  )
}

// ── Row (hover state lives here) ──────────────────────────────────────────────

function DropdownRow({
  item,
  selected,
  c,
  onSelect,
  rowRef,
}: {
  item: MentionResource
  selected: boolean
  c: AdaptiveColors
  onSelect: (resource: MentionResource) => void
  rowRef?: React.Ref<HTMLButtonElement>
}) {
  const [hovered, setHovered] = useState(false)
  const bg = selected ? c.navActive : hovered ? c.wash : "transparent"
  const nameColor = selected ? c.accent : hovered ? c.text : c.text2
  return (
    <button
      ref={rowRef}
      type="button"
      onMouseDown={(e) => {
        // Use mousedown (not click) so we don't lose input focus
        e.preventDefault()
        onSelect(item)
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 34,
        padding: "6px 14px 6px 10px",
        border: "none",
        borderRadius: 10,
        background: bg,
        cursor: "pointer",
        textAlign: "left",
        outline: "none",
        fontFamily: FONT_FAMILY,
        fontWeight: 400,
        color: nameColor,
        transition: "background 0.2s, color 0.2s",
        boxSizing: "border-box",
      }}
    >
      {/* Avatar or icon */}
      <DropdownAvatar
        avatarUrl={item.avatarUrl}
        name={item.name}
        type={item.type}
        c={c}
        selected={selected}
      />

      {/* Name + subtitle */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: "18px",
            fontWeight: 400,
            color: nameColor,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontFamily: FONT_FAMILY,
          }}
        >
          {item.name}
        </div>
        {item.subtitle && (
          <div
            style={{
              fontSize: 12,
              lineHeight: "16px",
              fontWeight: 400,
              color: c.text3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontFamily: FONT_FAMILY,
            }}
          >
            {item.subtitle}
          </div>
        )}
      </div>

      {/* ID meta (`.mi .meta`) */}
      <span
        style={{
          fontSize: 10,
          lineHeight: 1,
          fontWeight: 400,
          letterSpacing: "0.06em",
          color: c.text3,
          fontFamily: MONO_FAMILY,
          flexShrink: 0,
          marginLeft: "auto",
          paddingLeft: 12,
          maxWidth: 90,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.id.slice(0, 12)}…
      </span>
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface MentionDropdownProps {
  groups: MentionGroup[]
  selectedIndex: number
  onSelect: (resource: MentionResource) => void
  onClose: () => void
  /** Whether resources are still loading */
  isLoading?: boolean
}

export function MentionDropdown({
  groups,
  selectedIndex,
  onSelect,
  onClose,
  isLoading = false,
}: MentionDropdownProps) {
  const c = useMentionColors()
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedItemRef = useRef<HTMLButtonElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [onClose])

  // Flatten items to compute global index
  const flatItems: MentionResource[] = groups.flatMap((g) => g.items)
  const totalItems = flatItems.length

  // ── Shared container style (`.menu`) ───────────────────────────────────────
  const containerStyle: React.CSSProperties = {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    marginBottom: 6,
    backgroundColor: c.bgStep,
    border: `1px solid ${c.border}`,
    borderRadius: 16,
    boxShadow: c.elevRaised,
    padding: 6,
    zIndex: 9999,
    fontFamily: FONT_FAMILY,
    fontWeight: 400,
    color: c.text,
    overflow: "hidden",
    boxSizing: "border-box",
  }

  const quietStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: 34,
    padding: "6px 10px",
    fontSize: 13,
    lineHeight: "18px",
    color: c.text3,
    fontFamily: FONT_FAMILY,
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading && totalItems === 0) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={quietStyle}>
          <Ph name="circle-notch" size={14} color={c.text3} />
          <span>Cargando recursos…</span>
        </div>
      </div>
    )
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!isLoading && totalItems === 0) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={quietStyle}>
          <Ph name="magnifying-glass" size={14} color={c.text3} />
          <span>No se encontraron recursos</span>
        </div>
      </div>
    )
  }

  let globalIndex = 0

  return (
    <div
      ref={containerRef}
      style={
        {
          ...containerStyle,
          maxHeight: 280,
          overflowY: "auto",
          // Custom scrollbar
          scrollbarWidth: "thin",
          scrollbarColor: `${c.borderStrong} transparent`,
        } as React.CSSProperties
      }
    >
      {/* Groups (empty groups render nothing, not even their header) */}
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.type}>
            {/* Group header (`.msec`) */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 10px 4px",
                fontSize: 10,
                lineHeight: "12px",
                fontWeight: 400,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: c.text3,
                position: "sticky",
                top: 0,
                backgroundColor: c.bgStep,
                fontFamily: MONO_FAMILY,
                userSelect: "none",
                zIndex: 1,
              }}
            >
              <Ph name={TYPE_ICON[group.type] ?? FALLBACK_ICON} size={11} color={c.text3} />
              <span>{group.label}</span>
            </div>

            {/* Items (`.mi`) */}
            {group.items.map((item) => {
              const itemIndex = globalIndex++
              const isSelected = itemIndex === selectedIndex
              return (
                <DropdownRow
                  key={`${item.type}_${item.id}`}
                  item={item}
                  selected={isSelected}
                  c={c}
                  onSelect={onSelect}
                  rowRef={isSelected ? selectedItemRef : undefined}
                />
              )
            })}
          </div>
        ))}

      {/* Footer hint */}
      {totalItems > 0 && (
        <div
          style={{
            margin: "6px 4px 0",
            padding: "8px 6px 2px",
            borderTop: `1px solid ${c.border}`,
            display: "flex",
            gap: 14,
            alignItems: "center",
          }}
        >
          {[
            { keys: "↑↓", label: "navegar" },
            { keys: "↵ Tab", label: "seleccionar" },
            { keys: "Esc", label: "cerrar" },
          ].map(({ keys, label }) => (
            <span
              key={label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 10,
                lineHeight: "12px",
                color: c.text3,
                fontFamily: FONT_FAMILY,
              }}
            >
              <kbd
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 20,
                  height: 20,
                  border: `1px solid ${c.borderStrong}`,
                  borderRadius: 5,
                  padding: "0 5px",
                  fontSize: 10,
                  lineHeight: "12px",
                  color: c.text3,
                  fontFamily: MONO_FAMILY,
                  boxSizing: "border-box",
                }}
              >
                {keys}
              </kbd>
              <span>{label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
