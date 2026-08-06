/**
 * McaIcon — Theme-aware MCA icon renderer.
 *
 * Rendering priority:
 *   1. PNG / URL     → standard <Image> (brand logos, coloured icons).
 *   2. SVG (inline)  → fetch the .svg, replace hardcoded white strokes/fills
 *                       with `currentColor`, render via dangerouslySetInnerHTML.
 *                       This makes line-icons visible in both light and dark.
 *   3. Fallback      → 2-char initials from the mcaId.
 *
 * On native platforms (React Native without DOM), SVG inline rendering is
 * not available — we fall back to initials automatically.
 */

import React, { useEffect, useState } from 'react'
import { Image, Platform, Text, View, type ViewStyle } from 'react-native'
import { useColors } from './primitives/useColors'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isImageUrl(str?: string | null): boolean {
  if (!str) return false
  // SVG URLs are handled by the SVG inline path, not as raster images
  if (isSvgUrl(str)) return false
  return (
    str.startsWith('http://') ||
    str.startsWith('https://') ||
    str.startsWith('data:') ||
    str.endsWith('.png') ||
    str.endsWith('.jpg') ||
    str.endsWith('.jpeg')
  )
}

function isSvgUrl(str?: string | null): boolean {
  if (!str) return false
  return str.endsWith('.svg') || str.startsWith('data:image/svg')
}

function isDataUri(str?: string | null): boolean {
  return !!str && str.startsWith('data:')
}

/** Build the full URL for a relative icon path from the backend static endpoint. */
function resolveUrl(icon: string): string {
  if (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:')) {
    return icon
  }
  return `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ''}/static/mcas/${icon}`
}

/** Extract the raw SVG markup from a data: URI or a fetched string. */
function extractSvgMarkup(raw: string): string {
  if (raw.startsWith('data:image/svg')) {
    const commaIdx = raw.indexOf(',')
    if (commaIdx === -1) return raw
    const meta = raw.substring(0, commaIdx)
    const payload = raw.substring(commaIdx + 1)
    if (meta.includes('base64')) {
      try {
        return atob(payload)
      } catch {
        return raw
      }
    }
    try {
      return decodeURIComponent(payload)
    } catch {
      return payload
    }
  }
  return raw
}

/**
 * Replace hardcoded white/black stroke and fill with `currentColor` so the
 * SVG inherits the text colour of its container (theme-adaptive).
 *
 * Only replaces `white` / `#fff` / `#ffffff` (the line-icon convention) and
 * `black` / `#000` / `#000000`. Coloured icons (Discord's #5865F2, Google's
 * #4285F4, etc.) are left intact.
 */
/**
 * Normalise an SVG string for inline rendering:
 *   - Replace hardcoded white/black with `currentColor` (theme-adaptive)
 *   - Strip width/height attributes so the SVG fills its container
 *   - Add `width="100%" height="100%"` to enforce container sizing
 *   - Strip class/style attributes that may interfere
 */
function normaliseSvg(svg: string): string {
  let out = svg
    // Theme: white/black → currentColor
    .replace(/stroke=["']white["']/gi, 'stroke="currentColor"')
    .replace(/stroke=["']#fff(?:fff)?["']/gi, 'stroke="currentColor"')
    .replace(/stroke=["']#000(?:000)?["']/gi, 'stroke="currentColor"')
    .replace(/fill=["']white["']/gi, 'fill="currentColor"')
    .replace(/fill=["']#fff(?:fff)?["']/gi, 'fill="currentColor"')
    .replace(/fill=["']#000(?:000)?["']/gi, 'fill="currentColor"')

  // Remove width= and height= from the opening <svg ...> tag
  out = out.replace(/(<svg[^>]*?)\s+width=["'][^"']*["']/i, '$1')
  out = out.replace(/(<svg[^>]*?)\s+height=["'][^"']*["']/i, '$1')

  // Remove class= from the opening <svg ...> tag
  out = out.replace(/(<svg[^>]*?)\s+class=["'][^"']*["']/i, '$1')

  // Inject width="100%" height="100%" right after the opening <svg
  out = out.replace(/<svg\(/i, '<svg width="100%" height="100%"$1')

  return out
}

// ── Component ────────────────────────────────────────────────────────────────

export interface McaIconProps {
  /** The icon value from the manifest — URL, relative path, or null. */
  icon?: string | null
  /** Fallback: the mcaId (e.g. "mca.teros.bash") used for initials. */
  mcaId?: string
  /** Render size in pixels (default 24). */
  size?: number
  /** Override colour for SVG/initials. Defaults to the theme's text colour. */
  color?: string
  /** Background colour for the icon container. */
  backgroundColor?: string
  /** Border radius of the container (default 10). */
  borderRadius?: number
}

export function McaIcon({
  icon,
  mcaId,
  size = 24,
  color,
  backgroundColor,
  borderRadius = 10,
}: McaIconProps) {
  const c = useColors()
  const fg = color ?? c.text
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [svgFailed, setSvgFailed] = useState(false)

  // Only attempt SVG inline on web, and only when the icon IS an SVG
  const svgUrl = React.useMemo(() => {
    if (Platform.OS !== 'web') return null
    if (!icon || !isSvgUrl(icon)) return null
    return resolveUrl(icon)
  }, [icon])

  useEffect(() => {
    if (!svgUrl || svgFailed) {
      setSvgMarkup(null)
      return
    }

    let cancelled = false

    if (isDataUri(svgUrl)) {
      const markup = normaliseSvg(extractSvgMarkup(svgUrl))
      if (!cancelled) setSvgMarkup(markup)
      return
    }

    fetch(svgUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => {
        if (cancelled) return
        setSvgMarkup(normaliseSvg(text))
      })
      .catch(() => {
        if (cancelled) return
        setSvgFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [svgUrl, svgFailed])

  // ── Render ─────────────────────────────────────────────────────────────

  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius,
    backgroundColor: backgroundColor ?? 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  }

  // 1. PNG / URL image — highest priority
  if (isImageUrl(icon)) {
    return (
      <View style={containerStyle}>
        <Image
          source={{ uri: resolveUrl(icon!) }}
          style={{ width: size * 0.7, height: size * 0.7 }}
          resizeMode="contain"
        />
      </View>
    )
  }

  // 2. SVG inline (web only, when fetch succeeded)
  if (svgMarkup && Platform.OS === 'web') {
    return (
      <View style={containerStyle}>
        <div
          style={{
            width: size * 0.8,
            height: size * 0.8,
            color: fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 0,
          }}
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      </View>
    )
  }

  // 3. Fallback — 2-char initials
  const initials = mcaId
    ? mcaId.replace(/^mca\./, '').slice(0, 2).toUpperCase()
    : '?'
  return (
    <View style={containerStyle}>
      <Text
        style={{
          fontSize: size * 0.4,
          fontWeight: '600',
          color: fg,
          fontFamily: 'monospace',
        }}
      >
        {initials}
      </Text>
    </View>
  )
}
