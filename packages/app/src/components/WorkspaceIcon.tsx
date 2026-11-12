/**
 * WorkspaceIcon Component
 *
 * Renders the workspace's icon inside a tinted tile (the OS prototype's
 * `.tile` with the workspace colour). Icon names come from `WORKSPACE_ICONS`
 * (kebab-case, historically Lucide names): we draw them with the Phosphor
 * glyph of the same meaning and fall back to the Lucide component when there
 * is no Phosphor equivalent (the icon picker searches every Lucide name).
 */

import { COLOR_PALETTE, type WorkspaceColor } from "@teros/shared"
import React from "react"
import { StyleSheet, View } from "react-native"
import { useLucideIcons } from "../lib/lucideIcons"
import { Ph } from "./ui/ds"

// Convert kebab-case to PascalCase
function toPascalCase(str: string): string {
  return str
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

/**
 * Lucide name → Phosphor glyph. Every entry of `WORKSPACE_ICONS` resolves here;
 * anything else goes through the Lucide fallback below.
 */
const PH_ICONS: Record<string, string> = {
  folder: "folder",
  box: "cube",
  star: "star",
  heart: "heart",
  zap: "lightning",
  sparkles: "sparkle",
  flame: "fire",
  gem: "diamond",
  crown: "crown",
  award: "medal",
  briefcase: "briefcase",
  "building-2": "buildings",
  wallet: "wallet",
  calculator: "calculator",
  "chart-bar": "chart-bar",
  "trending-up": "trend-up",
  target: "target",
  code: "code",
  terminal: "terminal",
  cpu: "cpu",
  server: "hard-drives",
  database: "database",
  "git-branch": "git-branch",
  bug: "bug",
  wrench: "wrench",
  settings: "gear",
  "file-text": "file-text",
  "file-code": "file-code",
  "book-open": "book-open",
  notebook: "notebook",
  "clipboard-list": "clipboard-text",
  library: "books",
  mail: "envelope",
  "message-circle": "chat-circle",
  bell: "bell",
  megaphone: "megaphone",
  send: "paper-plane-tilt",
  palette: "palette",
  paintbrush: "paint-brush",
  camera: "camera",
  music: "music-notes",
  headphones: "headphones",
  user: "user",
  users: "users-three",
  home: "house",
  "graduation-cap": "graduation-cap",
  trophy: "trophy",
  brain: "brain",
  atom: "atom",
  microscope: "microscope",
  lightbulb: "lightbulb",
  rocket: "rocket",
  globe: "globe",
  shield: "shield",
  key: "key",
  clock: "clock",
  calendar: "calendar",
  bookmark: "bookmark",
  flag: "flag",
  package: "package",
  lock: "lock",
}

/** Phosphor glyph name for a workspace icon, or null when only Lucide has it. */
export function workspacePhIcon(icon: string | undefined): string | null {
  if (!icon) return "folder"
  return PH_ICONS[icon] ?? null
}

interface WorkspaceIconProps {
  /** Icon name in kebab-case (e.g., 'git-branch', 'rocket') */
  icon?: string
  /** Color name from design system (e.g., 'blue', 'purple') */
  color?: string
  /** Icon size (default: 14) */
  size?: number
  /** Whether to show background container (default: true) */
  showBackground?: boolean
  /** Container size (default: 24) */
  containerSize?: number
  /** Override the glyph colour (e.g. the picker's muted state). */
  iconColor?: string
}

export function WorkspaceIcon({
  icon = "folder",
  color = "amber",
  size = 14,
  showBackground = true,
  containerSize = 24,
  iconColor: iconColorOverride,
}: WorkspaceIconProps) {
  // Get colors from palette
  const palette = COLOR_PALETTE[color as WorkspaceColor] || COLOR_PALETTE.amber
  const iconColor = iconColorOverride ?? palette["500"]
  const bgColor = palette["500"] + "1F" // ~12% tint of the workspace colour

  const ph = workspacePhIcon(icon)
  // The Lucide set is a separate chunk, fetched only for a name Phosphor lacks.
  const lucide = useLucideIcons(!ph)
  let glyph: React.ReactNode
  if (ph) {
    glyph = <Ph name={ph} size={size} color={iconColor} />
  } else if (lucide) {
    const IconComponent = lucide[toPascalCase(icon)] || lucide.Folder
    glyph = <IconComponent size={size} color={iconColor} />
  } else {
    glyph = <Ph name="folder" size={size} color={iconColor} />
  }

  if (!showBackground) {
    return <>{glyph}</>
  }

  return (
    <View
      style={[
        styles.container,
        {
          width: containerSize,
          height: containerSize,
          borderRadius: Math.max(6, Math.round(containerSize * 0.26)),
          backgroundColor: bgColor,
        },
      ]}
    >
      {glyph}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
    overflow: "hidden",
  },
})
