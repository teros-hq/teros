/**
 * Persist higgsfield prediction outputs into ctx.objects.
 *
 * Higgsfield returns ephemeral CDN URLs in its prediction results (they
 * expire). Pablo's decision (2026-10-20): every MCA MUST return
 * objects-system URLs — never third-party ephemeral URLs — as tool output.
 *
 * The higgsfield result shape is opaque (passes through their API), so we
 * walk the result recursively and persist any external http(s) URL that
 * looks like a media file (video/image/audio extension or a known CDN
 * host), replacing it with the permanent objects-system URL.
 */

import { persistExternalMedia } from "@teros/mca-sdk"

/** Extensions we treat as persistable media. */
const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm", ".avi", ".mkv",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp3", ".wav", ".ogg", ".m4a",
])

/** Hosts known to serve higgsfield media (CDN). */
const MEDIA_HOST_HINTS = ["higgsfield", "cdn", "cloudfront", "storage.googleapis"]

/**
 * Check if a URL string looks like persistable media output.
 * We persist: URLs ending in a media extension, or URLs on known media CDNs.
 * We skip: status_url / cancel_url (API endpoints, not media).
 */
function isMediaUrl(url: string, key?: string): boolean {
  // Never persist API control URLs
  if (key === "status_url" || key === "cancel_url") return false
  if (url.includes("/requests/") && url.includes("/status")) return false
  if (url.includes("/requests/") && url.includes("/cancel")) return false

  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()

    // Media extension match
    for (const ext of MEDIA_EXTENSIONS) {
      if (path.endsWith(ext)) return true
    }

    // Known CDN host
    for (const hint of MEDIA_HOST_HINTS) {
      if (parsed.hostname.includes(hint)) return true
    }

    return false
  } catch {
    return false
  }
}

export interface PersistResult {
  /** The result with external media URLs replaced by objects-system URLs. */
  output: any
  /** ObjectIds of persisted objects (in traversal order). */
  objectIds: string[]
  /** Warnings for files that could not be persisted. */
  warnings: string[]
}

/**
 * Recursively walk a higgsfield result and persist any external media URL
 * into ctx.objects, replacing it with the permanent objects-system URL.
 */
export async function persistHiggsfieldOutput(
  result: any,
  context: any,
  metadata: Record<string, string> = {},
): Promise<PersistResult> {
  const objectIds: string[] = []
  const warnings: string[] = []

  async function walk(value: any, key?: string): Promise<any> {
    if (typeof value === "string" && value.startsWith("http") && isMediaUrl(value, key)) {
      try {
        const persisted = await persistExternalMedia(value, context, {
          source: "higgsfield",
          metadata,
        })
        if (persisted.objectId) objectIds.push(persisted.objectId)
        if (persisted.warning) warnings.push(persisted.warning)
        return persisted.url
      } catch (err) {
        // Download failed — keep original URL and warn
        warnings.push(`Failed to persist ${value}: ${err instanceof Error ? err.message : String(err)}`)
        return value
      }
    }

    if (Array.isArray(value)) {
      const out: any[] = []
      for (const item of value) {
        out.push(await walk(item))
      }
      return out
    }

    if (value !== null && typeof value === "object") {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(value)) {
        out[k] = await walk(v, k)
      }
      return out
    }

    return value
  }

  const output = await walk(result)
  return { output, objectIds, warnings }
}
