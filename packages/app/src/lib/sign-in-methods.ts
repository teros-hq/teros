/**
 * Sign-in methods — client side (spec SIGNM).
 *
 * The backend says which sign-in methods it offers at `GET /api/auth-methods`
 * (email and password always; Google, GitHub and Microsoft only when their
 * credentials are configured). The sign-in screens draw a button only for
 * those. When the answer does not arrive, only email and password are shown.
 */

export interface SignInMethods {
  password: true
  google: boolean
  github: boolean
  microsoft: boolean
}

export type SocialProvider = "google" | "github" | "microsoft"

/** Display order of the provider buttons. @spec SIGNM-REQ-4 */
export const SOCIAL_PROVIDER_ORDER: readonly SocialProvider[] = ["google", "github", "microsoft"]

/** What the screens show when the backend does not answer. @spec SIGNM-REQ-7 */
export const PASSWORD_ONLY: SignInMethods = {
  password: true,
  google: false,
  github: false,
  microsoft: false,
}

export const SIGN_IN_METHODS_TIMEOUT_MS = 3000

/** The providers to draw, in display order. @spec SIGNM-REQ-4 */
export function enabledSocialProviders(methods: SignInMethods): SocialProvider[] {
  return SOCIAL_PROVIDER_ORDER.filter((provider) => methods[provider] === true)
}

/**
 * Ask the backend which sign-in methods it offers. A failure of any kind (no
 * backend URL, network error, non-200, malformed body, timeout) is "email and
 * password only".
 *
 * @spec SIGNM-REQ-4 SIGNM-REQ-7
 */
export async function fetchSignInMethods(
  backendBase: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInMethods> {
  if (!backendBase) return PASSWORD_ONLY
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), SIGN_IN_METHODS_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${backendBase.replace(/\/$/, "")}/api/auth-methods`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    })
    if (!res.ok) return PASSWORD_ONLY
    const body = (await res.json()) as Partial<Record<SocialProvider, unknown>> | null
    if (!body || typeof body !== "object") return PASSWORD_ONLY
    return {
      password: true,
      google: body.google === true,
      github: body.github === true,
      microsoft: body.microsoft === true,
    }
  } catch {
    return PASSWORD_ONLY
  } finally {
    clearTimeout(timer)
  }
}
