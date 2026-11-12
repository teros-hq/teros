import type React from "react"
import { XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface IconChipProps {
  /** Icon React node (p.ej. <User size={10} color={...} />). Opcional. */
  icon?: React.ReactNode
  /** Texto corto del chip. */
  text: string
  /** Color de acento — afecta texto, borde y fondo semi-translúcido. */
  accent?: string
  /** Si true, pinta solo el borde y el texto (sin fondo). Default false. */
  outline?: boolean
}

/** A tinted `.badge` with a glyph: 10px sans on a 10% wash of the accent, radius 5. */
export function IconChip({ icon, text, accent, outline = false }: IconChipProps): React.ReactNode {
  const c = useColors()
  // Default accent: the theme violet (good contrast in both themes).
  const color = accent ?? c.accent
  const bg = outline ? "transparent" : `${color}1a` // ~10% alpha
  const borderColor = outline ? `${color}66` : "transparent"

  return (
    <XStack
      backgroundColor={bg}
      borderWidth={1}
      borderColor={borderColor}
      borderRadius={5}
      paddingHorizontal={7}
      paddingVertical={2}
      alignItems="center"
      gap={5}
      alignSelf="flex-start"
    >
      {icon}
      <T step="sm" color={color} numberOfLines={1} style={{ fontSize: 10, lineHeight: 13 }}>
        {text}
      </T>
    </XStack>
  )
}
