/**
 * Frontend UX throttle for password-reset code requests (Pablo, 2026-11-12):
 * after asking for a code, wait 20s before asking for another. Shared by the
 * forgot screen (initial request) and the reset screen (resend) via the
 * module-level lastCodeRequestAt, so hopping between screens does not reset
 * the wait. Pure UX — the backend already rate-limits 3/hour/email.
 */
export const CODE_REQUEST_THROTTLE_S = 20

let lastCodeRequestAt = 0

export function secondsUntilNextCodeRequest(now = Date.now()): number {
  const elapsed = (now - lastCodeRequestAt) / 1000
  return Math.max(0, Math.ceil(CODE_REQUEST_THROTTLE_S - elapsed))
}

export function markCodeRequest(): void {
  lastCodeRequestAt = Date.now()
}

/** Test seam: reset the shared window. */
export function resetCodeRequestThrottleForTests(): void {
  lastCodeRequestAt = 0
}
