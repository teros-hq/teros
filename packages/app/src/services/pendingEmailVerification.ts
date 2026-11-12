/**
 * The email verification a password login or signup is waiting on.
 *
 * Held in memory (not in the route params) so the challenge token never lands
 * in the URL or the browser history. A reload loses it, and the verify screen
 * sends the user back to sign in — the server would have to re-issue anyway.
 */

export interface PendingEmailVerification {
  challengeToken: string
  email: string
  /** Fallback display name for the session user (signup knows the real one) */
  displayName: string
  method: "login" | "signup"
}

let pending: PendingEmailVerification | null = null

export function setPendingEmailVerification(value: PendingEmailVerification): void {
  pending = value
}

export function getPendingEmailVerification(): PendingEmailVerification | null {
  return pending
}

export function clearPendingEmailVerification(): void {
  pending = null
}
