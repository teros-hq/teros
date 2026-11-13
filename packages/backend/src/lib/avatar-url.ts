import { config } from "../config"
import { isObjectId } from "../services/platform-objects"

/** `<backend public URL>/objects/` — the prefix of every object URL this backend serves. */
function objectsBaseUrl(): string {
  return `${config.agentApps.publicUrl.replace(/\/$/, "")}/objects/`
}

/**
 * Resolve a stored avatar value to a public URL.
 *
 * Idempotent by design: values that are already absolute URLs or root-relative
 * paths are returned unchanged. An object id (an uploaded avatar, OBJ-REQ-4)
 * becomes its object URL. A bare filename (the avatars the repository ships,
 * e.g. "iria.png", "avatars/default-03.jpg") gets the static base prepended.
 *
 * Single source of truth — replaces 9 duplicated copies, several of which lacked
 * the absolute-URL guard. A non-idempotent copy double-wrapped an absolute value
 * into `<base>/<base>/<file>` → 404 → broken avatar on reload.
 *
 * @spec OBJ-REQ-5
 */
export function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  if (/^https?:\/\//i.test(avatarFilename) || avatarFilename.startsWith("/")) {
    return avatarFilename
  }
  if (isObjectId(avatarFilename)) return `${objectsBaseUrl()}${avatarFilename}`
  return `${config.static.baseUrl}/${avatarFilename}`
}

/**
 * The value to store for an avatar a client sends in an agent update. A client
 * holds resolved URLs, so it sends this backend's own object URL back (with or
 * without transform parameters): store the object id, not the URL. Anything
 * else is stored as received.
 *
 * @spec OBJ-REQ-5
 */
export function toStoredAvatarValue(value: string): string {
  const base = objectsBaseUrl()
  if (!value.startsWith(base)) return value
  const objectId = value.slice(base.length).split(/[?#]/)[0]
  return isObjectId(objectId) ? objectId : value
}
