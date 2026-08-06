import { config } from '../config'

/**
 * Resolve a stored avatar value to a public URL.
 *
 * Idempotent by design: values that are already absolute URLs or root-relative
 * paths are returned unchanged; only bare filenames (the storage convention —
 * e.g. predefined core avatars like "iria.png", and uploaded avatars stored as
 * "<agentId>-avatar-<uuid>.png") get the static base prepended.
 *
 * Single source of truth — replaces 9 duplicated copies, several of which lacked
 * the absolute-URL guard. A non-idempotent copy double-wrapped an absolute value
 * into `<base>/<base>/<file>` → 404 → broken avatar on reload.
 */
export function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  if (/^https?:\/\//i.test(avatarFilename) || avatarFilename.startsWith('/')) {
    return avatarFilename
  }
  return `${config.static.baseUrl}/${avatarFilename}`
}
