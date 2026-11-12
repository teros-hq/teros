/**
 * Avatar — the "Stories" avatar of the OS prototype (design-testing, Oct 2026).
 *
 * A circle with a thin ring and a gap, like a story bubble:
 *   agent  the brand conic ring (mint → violet → yellow) on web; a solid
 *          accent ring on native, where there is no conic-gradient.
 *   human  the mint tint: Mint/100 disc with Mint/500 initials, no ring.
 * Ring width tracks the size (1.5 → 4px). The initials glyph is Prody 400 —
 * the hierarchy comes from size, never from bold.
 *
 * Web: an agent has no ring — its PRESENCE (ThinkingGlow) sits behind the
 * face instead: a quiet violet rim at rest that wakes into the full thinking
 * glow while `status="busy"`, with animated transitions both ways. Native
 * keeps the ring (brand / amber when busy). `status="idle"` (paused, closed)
 * keeps the grey ring everywhere.
 */

import React from "react"
import { ThinkingGlow } from "./avatar/ThinkingGlow"
import { Image, Platform, View as RNView, Text as RNText } from "react-native"
import { useImageWithFallback } from "../hooks/useImageWithFallback"
import { getAvatarUrl } from "../lib/image-url"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors } from "./mca/primitives/colors"
import { FONT_SERIF } from "./mca/primitives/fonts"
import { fx } from "../styles/fx"

interface AvatarProps {
  /** Display name (used for initials fallback) */
  name: string
  /** Avatar image URL */
  imageUrl?: string | null
  /** Size in pixels (default: 32) */
  size?: number
  /** Whether this is an agent (brand ring) or human (mint disc) */
  isAgent?: boolean
  /** Ring state for agents. */
  status?: "live" | "idle" | "busy"
  /** Square avatar (the old R18 look) — for places that still need it. */
  square?: boolean
}

/** Ring width + gap per size step (the prototype's --rw / --gp). */
function ringFor(size: number): { rw: number; gp: number } {
  if (size <= 20) return { rw: 1.5, gp: 1 }
  if (size <= 28) return { rw: 2, gp: 1.5 }
  if (size <= 36) return { rw: 2, gp: 2 }
  if (size <= 48) return { rw: 2.5, gp: 2.5 }
  if (size <= 64) return { rw: 3, gp: 3 }
  return { rw: 4, gp: 4 }
}

/**
 * Get initials from a name (first letter of first and last word)
 */
function getInitials(name: string): string {
  const words = (name || "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].charAt(0).toUpperCase()
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase()
}

const RING_BRAND =
  "conic-gradient(from var(--ra, 200deg), #1EFFCE, #6F27FF, #9C6BFF, #FFFFB0, #1EFFCE)"
const RING_BUSY = "conic-gradient(from var(--ra, 200deg), #F59E0B, #FFFFB0, #F59E0B)"

export function Avatar({
  name,
  imageUrl,
  size = 32,
  isAgent = false,
  status = "live",
  square = false,
}: AvatarProps) {
  const c = useColors()
  const initials = getInitials(name)
  const { rw, gp } = isAgent ? ringFor(size) : { rw: 0, gp: 0 }
  const inner = size - 2 * (rw + gp)
  const radius = square ? Math.round(size * 0.28) : size / 2
  const innerRadius = square ? Math.max(2, radius - rw - gp) : inner / 2
  const fontSize = Math.max(9, Math.floor(inner * 0.42))

  // Fall back to initials when the image fails to load (404, broken URL…).
  // Resize on-the-fly via backend Sharp integration (2x for retina, WebP).
  const resizedImageUrl = getAvatarUrl(imageUrl, size)
  const { showImage, onError } = useImageWithFallback(resizedImageUrl)

  // Web agents wear their presence instead of a ring (not for the square
  // legacy look, nor while idle — paused/closed keeps the grey ring).
  const presence = Platform.OS === "web" && !square && status !== "idle"
  const working = status === "busy"

  const ringColor =
    status === "idle" ? c.borderStrong : status === "busy" ? semanticColors.amber : c.accent
  const ringWeb = status === "idle" ? c.borderStrong : status === "busy" ? RING_BUSY : RING_BRAND

  const face = (
    <RNView
      style={{
        width: inner,
        height: inner,
        borderRadius: innerRadius,
        overflow: "hidden",
        backgroundColor: isAgent ? c.tile : c.tint.m.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {showImage && imageUrl ? (
        Platform.OS === "web" ? (
          <img
            src={resizedImageUrl}
            alt={name}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
            onError={onError}
          />
        ) : (
          <Image
            source={{ uri: resizedImageUrl }}
            style={{ width: inner, height: inner }}
            onError={onError}
          />
        )
      ) : (
        <RNText
          style={{
            fontFamily: FONT_SERIF,
            fontSize,
            lineHeight: Math.round(fontSize * 1.1),
            color: isAgent ? c.accent : c.tint.m.tx,
            fontWeight: "400",
          }}
        >
          {initials}
        </RNText>
      )}
    </RNView>
  )

  if (!isAgent) {
    return (
      <RNView
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {face}
      </RNView>
    )
  }

  // Agent: ring (gradient on web, solid on native) → gap → face. The ring
  // turns slowly (storyspin) unless the agent is idle. Working (web): no
  // ring — the thinking glow orbits behind the face instead.
  return (
    <RNView
      {...fx(status === "idle" || presence ? "av" : "av ring")}
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          padding: rw,
        },
        Platform.OS === "web"
          ? ({
              background: presence ? "transparent" : ringWeb,
              position: "relative",
              isolation: "isolate",
            } as any)
          : { backgroundColor: ringColor },
      ]}
    >
      {presence ? <ThinkingGlow size={size} working={working} /> : null}
      <RNView
        style={{
          // With a presence the "gap" shrinks to the face: an opaque disc that
          // hides the glow everywhere except the rim around the face.
          width: presence ? inner : size - 2 * rw,
          height: presence ? inner : size - 2 * rw,
          borderRadius: square ? Math.max(1, radius - rw) : (presence ? inner : size - 2 * rw) / 2,
          backgroundColor: c.bgSheet,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {face}
      </RNView>
    </RNView>
  )
}
