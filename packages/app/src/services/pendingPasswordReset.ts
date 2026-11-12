/**
 * The password reset a user is waiting on.
 *
 * Held in memory (not in the route params) so the challenge token never lands
 * in the URL or the browser history. A reload loses it, and the reset screen
 * sends the user back to sign in — the server would have to re-issue anyway.
 */

export interface PendingPasswordReset {
  challengeToken: string
  email: string
  /** The emailed code, once the server confirmed it (step 1 → step 2). PWR-REQ-8 */
  code?: string
}

let pending: PendingPasswordReset | null = null

export function setPendingPasswordReset(value: PendingPasswordReset): void {
  pending = value
}

export function getPendingPasswordReset(): PendingPasswordReset | null {
  return pending
}

export function clearPendingPasswordReset(): void {
  pending = null
}
