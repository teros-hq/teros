import type React from "react"
import { Image, XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface IconTileProps {
  /** URL de imagen. Prioriza sobre icon/fallback. */
  src?: string
  /** Icon React node (fallback si no hay src). */
  icon?: React.ReactNode
  /** Texto corto (ej. inicial o 2 letras) si no hay src ni icon. */
  label?: string
  /** Tamaño en px. Default 32. */
  size?: number
  /** Color acento: pinta el bg semi-translúcido y el label. Default: el violeta del tema. */
  accent?: string
  /** Rounded corners. Default 8 (`.tile` del prototipo: 6 en xs, 10 a partir de 36). */
  radius?: number
}

/** The prototype's `.tile`: violet wash + accent glyph (or initials), no border. */
export function IconTile({
  src,
  icon,
  label,
  size = 32,
  accent,
  radius = 8,
}: IconTileProps): React.ReactNode {
  const c = useColors()
  if (src) {
    return <Image source={{ uri: src }} width={size} height={size} borderRadius={radius} />
  }

  const color = accent ?? c.accent
  const bg = accent ? `${accent}1a` : c.tile
  const fontSize = Math.max(9, Math.round(size * 0.35))

  return (
    <XStack
      width={size}
      height={size}
      borderRadius={radius}
      backgroundColor={bg}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      overflow="hidden"
    >
      {icon ?? (
        <T step="code" color={color} style={{ fontSize, lineHeight: fontSize + 2 }}>
          {label?.slice(0, 2) ?? "?"}
        </T>
      )}
    </XStack>
  )
}
