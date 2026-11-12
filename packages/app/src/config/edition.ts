/**
 * Deployment edition as the app knows it at runtime (ONB-REQ-1).
 *
 * The frontend image is published once for every deployment (WEBCFG), so the
 * edition cannot be a build-time constant: it comes from `profile.get` and is
 * kept on the auth store's user. Until the profile has synced the app assumes
 * `self-hosted`, the backend's own default (`resolveTerosEdition`).
 *
 * @spec ONB-REQ-1
 */
import { useAuthStore } from "../store/authStore"

export type Edition = "self-hosted" | "cloud"

export const DEFAULT_EDITION: Edition = "self-hosted"

/** The edition recorded for the signed-in user, or the default. */
export function resolveEdition(value: string | undefined | null): Edition {
  return value === "cloud" ? "cloud" : DEFAULT_EDITION
}

/** React hook: the current deployment edition. */
export function useEdition(): Edition {
  return useAuthStore((s) => resolveEdition(s.user?.edition))
}
