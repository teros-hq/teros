/**
 * Image URL utilities for on-the-fly resizing
 *
 * Appends resize query params to static image URLs served by the backend.
 * The backend (Sharp) handles the actual resizing and caches the result.
 *
 * Usage:
 *   getResizedImageUrl(avatarUrl, { width: 64, height: 64, format: 'webp' })
 *   // → 'https://be.teros.ai/static/avatar.jpg?w=64&h=64&format=webp'
 */

export interface ImageResizeOptions {
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  format?: 'jpeg' | 'jpg' | 'png' | 'webp' | 'avif' | 'gif'
  quality?: number
}

/**
 * Check if a URL points to a resizable image on our backend
 */
function isResizableBackendImage(url: string): boolean {
  if (!url) return false
  // Must be our backend static route
  if (!url.includes('/static/')) return false
  // Must be an image extension
  const path = url.split('?')[0].toLowerCase()
  return /\.(jpg|jpeg|png|webp|gif|avif|tiff|svg)$/.test(path)
}

/**
 * Append resize parameters to an image URL
 *
 * Returns the original URL unchanged if:
 * - No options provided
 * - URL is not a resizable backend image
 * - URL already has resize params
 */
export function getResizedImageUrl(
  url: string | undefined | null,
  options: ImageResizeOptions,
): string | undefined {
  if (!url) return undefined
  if (!isResizableBackendImage(url)) return url

  // Don't add params if already present (avoid double-resize)
  if (url.includes('w=') || url.includes('h=')) return url

  const params = new URLSearchParams()

  if (options.width) params.set('w', String(options.width))
  if (options.height) params.set('h', String(options.height))
  if (options.fit) params.set('fit', options.fit)
  if (options.format) params.set('format', options.format)
  if (options.quality) params.set('q', String(options.quality))

  const queryString = params.toString()
  if (!queryString) return url

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${queryString}`
}

/**
 * Get a resized avatar URL optimized for the given display size
 *
 * Uses 2x pixel ratio for retina displays, WebP format for compression.
 */
export function getAvatarUrl(
  url: string | undefined | null,
  displaySize: number,
): string | undefined {
  if (!url) return undefined

  // 2x for retina, capped at 512px (avatars rarely need more)
  const size = Math.min(displaySize * 2, 512)

  return getResizedImageUrl(url, {
    width: size,
    height: size,
    fit: 'cover',
    format: 'webp',
    quality: 80,
  })
}
