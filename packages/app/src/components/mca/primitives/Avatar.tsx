import type React from "react"
import { Platform } from "react-native"
import { Image, Text, XStack } from "tamagui"
import { colors } from "./colors"
import { surface } from "./colors"
import { useMcaTheme } from "./useColors"
import { useImageWithFallback } from "../../../hooks/useImageWithFallback"

interface AvatarProps {
  /** URL de la imagen. Si falta, se pinta el fallback con inicial. */
  src?: string
  /** Texto para extraer inicial cuando no hay src (e.g., fullName). */
  name?: string
  /** Tamaño en px. Default 20. */
  size?: number
  /** Color de fondo del fallback. Default auto según `isAgent`. */
  bg?: string
  /** Si es un agente (accent ring) o un humano (Essentials ring). Default: humano. */
  isAgent?: boolean
}

/** Ring width for every entity kind — DS.avatar.ring.width (R18). */
const RING_WIDTH = 2

/** DS.radiusAvatar — the radius tracks the size, not a fixed proportion. */
function radiusForSize(size: number): number {
  if (size <= 20) return 3 // xs 20px — inline / mention chips
  if (size <= 28) return 8 // sm 28px — list items, compact rows
  if (size <= 48) return 10 // md 36 / lg 48 — nav, cards, messages
  if (size <= 64) return 12 // xl 64px — agent profile page
  return 14 // 2xl 96px — hero / featured agent
}

function getInitial(name?: string): string {
  if (!name) return "?"
  const trimmed = name.trim()
  if (!trimmed) return "?"
  return trimmed.charAt(0).toUpperCase()
}

export function Avatar({
  src,
  name,
  size = 20,
  bg,
  isAgent = false,
}: AvatarProps): React.ReactNode {
  const theme = useMcaTheme()
  const t = surface[theme]
  const radius = radiusForSize(size)
  const w = RING_WIDTH
  const { showImage, onError } = useImageWithFallback(src)

  // R18 entity ring: agents take the theme accent (solid, via box-shadow);
  // humans take the Essentials conic ring on web, Mint/200 on native (no
  // conic-gradient there). Same 2px width for everyone.
  const ringColor = isAgent ? t.accent : colors.mint200
  const solidRing = `0 0 0 ${w}px ${ringColor}`
  const accentWash = theme === "light" ? "rgba(111,39,255,0.10)" : "rgba(156,107,255,0.10)"

  if (showImage) {
    const img = (
      <Image
        source={{ uri: src }}
        width={size}
        height={size}
        borderRadius={radius}
        onError={onError}
      />
    )
    if (isAgent) {
      return (
        <XStack
          width={size}
          height={size}
          borderRadius={radius}
          overflow="hidden"
          flexShrink={0}
          style={{ boxShadow: solidRing }}
        >
          {img}
        </XStack>
      )
    }
    return (
      <XStack
        width={size + w * 2}
        height={size + w * 2}
        borderRadius={radius + w}
        flexShrink={0}
        {...(Platform.OS === "web"
          ? {
              style: { background: colors.avatarRingHuman },
            }
          : { backgroundColor: ringColor })}
      >
        {img}
      </XStack>
    )
  }

  const initial = getInitial(name)
  const backgroundColor = bg ?? (isAgent ? accentWash : t.bgItem)
  const textColor = isAgent ? t.accent : t.text
  const fontSize = Math.max(8, Math.round(size * 0.5))

  const face = (
    <XStack
      width={size}
      height={size}
      borderRadius={radius}
      backgroundColor={backgroundColor}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      {/* Brand rule: 400 always — the DS initials glyph is Prody 400. */}
      <Text color={textColor} fontSize={fontSize} fontFamily="Prody">
        {initial}
      </Text>
    </XStack>
  )

  if (isAgent) {
    return (
      <XStack
        width={size}
        height={size}
        borderRadius={radius}
        flexShrink={0}
        style={{ boxShadow: solidRing }}
      >
        {face}
      </XStack>
    )
  }

  return (
    <XStack
      width={size + w * 2}
      height={size + w * 2}
      borderRadius={radius + w}
      flexShrink={0}
      {...(Platform.OS === "web"
        ? {
            style: { background: colors.avatarRingHuman },
          }
        : { backgroundColor: ringColor })}
    >
      {face}
    </XStack>
  )
}
