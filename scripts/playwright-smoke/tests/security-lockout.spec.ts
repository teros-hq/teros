/**
 * Lockout counter reset after the lockout window elapses (TER-450 / #157).
 *
 * Bug: a legitimate user who hit the 5-failure lockout and waited it out got
 * RE-LOCKED on the very first password typo — the failed-attempt counter stayed
 * pinned at MAX, so they effectively had 0 attempts, not a fresh 5.
 *
 * Fix (identity-service.verifyPassword): once a lockout has elapsed
 * (`data.lockedUntil` set but in the past), the counter resets to 0 before the
 * attempt — OWASP Authentication Cheat Sheet. So the first post-lockout mistake
 * yields plain `invalid_credentials`, not another `account_locked`.
 *
 * We can't wait 15 real minutes, so we put the identity in the "lockout just
 * expired" state directly in Mongo (failedAttempts:5, lockedUntil:past) on a
 * DEDICATED throwaway user, then drive ONE wrong-password login over a throwaway
 * WS and assert the verdict.
 *
 * Note on the discriminator: a failure that TRIPS the lock still returns
 * `invalid_credentials` (the `account_locked` message only surfaces on the NEXT
 * attempt). So the load-bearing facts are (a) the counter after the mistake — 1
 * with the fix vs 6 with the bug — and (b) the FOLLOW-UP login with the CORRECT
 * password: it succeeds with the fix, but is rejected with `Account temporarily
 * locked` under the bug (the single typo re-locked the account).
 *
 * Mutation check: revert `verifyPassword` to the bug
 * (`const priorFailedAttempts = data.failedAttempts`) → counter goes to 6 +
 * lockedUntil set + the correct-password follow-up is rejected → the assertions
 * go red.
 */
import { closeDb, ensureLockoutUser, getIdentityLockState, setIdentityLockState } from "../helpers/db"
import { evalTeros, rawWsLogin } from "../helpers/teros"
import { expect, test } from "../fixtures"

const PROBE_EMAIL = "lockout-probe@test.com"
const PROBE_PASS = "correct-horse-battery"

const LOCKED = "Account temporarily locked"
const BAD_CREDS = "Invalid email or password"

test.afterAll(async () => {
  await closeDb()
})

test.describe("security — lockout reset tras expirar la ventana @security", () => {
  test("un fallo tras el lockout expirado NO re-bloquea (ventana fresca de 5)", async ({
    terosPage,
  }) => {
    await ensureLockoutUser(PROBE_EMAIL, PROBE_PASS)
    // The page's own client URL (ws://localhost:10021/ws) — reuse it for the probe.
    const wsUrl = await evalTeros(
      terosPage,
      () => (window.teros.transport as { url?: string }).url ?? "",
    )
    expect(wsUrl, "WS url del cliente").toMatch(/^wss?:\/\//)

    // Simulate "lockout just elapsed": MAX failures + a lockedUntil in the past.
    await setIdentityLockState(PROBE_EMAIL, {
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() - 60_000),
    })

    // ONE wrong password. With the fix the counter resets to 0 first, so this is
    // attempt #1 of a fresh window (bad-credentials either way — the lock message
    // only surfaces on the NEXT attempt, so this is not the discriminator).
    const firstMistake = await rawWsLogin(terosPage, wsUrl, PROBE_EMAIL, "definitely-wrong")
    expect(firstMistake.success, "login con password incorrecta no tiene éxito").toBe(false)
    expect(firstMistake.error ?? "", "un fallo da credenciales inválidas").toContain(BAD_CREDS)

    // Discriminator #1 — the counter is now 1 (fresh window), NOT 6, and there is
    // no active lock. Under the bug it would be 6 with lockedUntil set.
    const after = await getIdentityLockState(PROBE_EMAIL)
    expect(after?.failedAttempts, "contador reiniciado a 1 (no 6)").toBe(1)
    expect(after?.lockedUntil ?? null, "sin lockout activo tras un solo fallo").toBeNull()

    // Discriminator #2 — the CORRECT password now lets the user in. Under the bug
    // the single typo re-locked the account, so this would fail with `LOCKED`.
    const good = await rawWsLogin(terosPage, wsUrl, PROBE_EMAIL, PROBE_PASS)
    expect(good.error ?? "", "no debe quedar bloqueado tras un único fallo").not.toContain(LOCKED)
    expect(good.success, "con la password correcta entra sin problemas").toBe(true)
  })
})
