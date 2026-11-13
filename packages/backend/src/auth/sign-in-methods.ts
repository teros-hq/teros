/**
 * Sign-in methods this backend offers (spec SIGNM).
 *
 * Email and password always work. Each social provider (Google, GitHub,
 * Microsoft) is offered only when its sign-in was initialised at boot, which
 * needs a client id and secret in the `oauth` system secret
 * (bootstrap/server-bootstrap.ts). The sign-in screens ask
 * `GET /api/auth-methods` and draw a button only for what is offered.
 */

export type SocialSignInProvider = "google" | "github" | "microsoft"

/** @spec SIGNM-REQ-1 SIGNM-REQ-3 */
export interface SignInMethods {
  password: true
  google: boolean
  github: boolean
  microsoft: boolean
}

const enabled: Record<SocialSignInProvider, boolean> = {
  google: false,
  github: false,
  microsoft: false,
}

/**
 * Record that a social provider's sign-in was initialised at boot.
 * @spec SIGNM-REQ-2
 */
export function enableSocialSignIn(provider: SocialSignInProvider): void {
  enabled[provider] = true
}

/**
 * The methods offered right now: exactly these four flags, nothing else.
 * @spec SIGNM-REQ-1 SIGNM-REQ-2 SIGNM-REQ-3
 */
export function getSignInMethods(): SignInMethods {
  return {
    password: true,
    google: enabled.google,
    github: enabled.github,
    microsoft: enabled.microsoft,
  }
}

export function _resetSignInMethodsForTests(): void {
  enabled.google = false
  enabled.github = false
  enabled.microsoft = false
}
