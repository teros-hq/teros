/**
 * AccesoTab — gated user-modification actions. Assertions that BITE:
 *   - ROLE VISIBILITY: a `super` caller sees the Rol selector + Impersonar; an
 *     `admin` caller does NOT (mutation: removing the super-gate turns this red),
 *   - SELF-BLOCK: the caller can't change their OWN role or suspend themselves,
 *   - a super TARGET can't be suspended,
 *   - HAPPY-PATH: Suspender → confirm → updateUserStatus(userId,'suspended') with
 *     the EXACT args, and the row is patched via onUpdate.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/detail/AccesoTab.render.test.tsx
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import type { UserRole, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const updateUserStatus = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) => Promise.resolve({ user: {} })),
)
const updateUserRole = vi.hoisted(() => vi.fn((..._a: unknown[]) => Promise.resolve({ user: {} })))
const grantAccess = vi.hoisted(() => vi.fn((..._a: unknown[]) => Promise.resolve({ user: {} })))
const verifyStepUp = vi.hoisted(() => vi.fn((..._a: unknown[]) => Promise.resolve({ verified: true, expiresAt: "2026-01-01T00:00:00Z" })))
const clientMock = vi.hoisted(() => ({
  admin: {
    updateUserStatus: (...a: unknown[]) => updateUserStatus(...a),
    updateUserRole: (...a: unknown[]) => updateUserRole(...a),
    grantAccess: (...a: unknown[]) => grantAccess(...a),
    verifyStepUp: (...a: unknown[]) => verifyStepUp(...a),
  },
}))
vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => clientMock }))

import { AccesoTab } from "./AccesoTab"

function mkUser(over: Partial<UserSummary> = {}): UserSummary {
  return {
    userId: "u1",
    profile: { displayName: "Ana", email: "ana@x.io" },
    role: "user",
    status: "active",
    emailVerified: true,
    accessGranted: true,
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    providers: [],
    stats: { apps: 0, channels: 0 },
    activity: [],
    billing: null,
    ...over,
  } as UserSummary
}

function renderAcceso(opts: {
  user?: UserSummary
  callerRole?: UserRole
  callerUserId?: string
  onUpdate?: (p: Partial<UserSummary>) => void
  onImpersonate?: () => Promise<void>
}) {
  return renderWithTamagui(
    <AccesoTab
      user={opts.user ?? mkUser()}
      callerRole={opts.callerRole}
      callerUserId={opts.callerUserId ?? "admin_1"}
      isImpersonating={false}
      onUpdate={opts.onUpdate ?? (() => {})}
      onImpersonate={opts.onImpersonate ?? (() => Promise.resolve())}
    />,
  )
}

beforeEach(() => {
  updateUserStatus.mockClear()
  updateUserRole.mockClear()
  grantAccess.mockClear()
  verifyStepUp.mockClear()
})

describe("AccesoTab role visibility", () => {
  it("a super caller sees the Rol selector and Impersonar", () => {
    const { getByTestId } = renderAcceso({ callerRole: "super" })
    expect(getByTestId("acceso-role-group")).toBeTruthy()
    expect(getByTestId("acceso-impersonate")).toBeTruthy()
  })

  it("an admin caller does NOT see the Rol selector nor Impersonar", () => {
    const { queryByTestId, getByTestId } = renderAcceso({ callerRole: "admin" })
    expect(queryByTestId("acceso-role-group")).toBeNull()
    expect(queryByTestId("acceso-impersonate")).toBeNull()
    // …but a plain admin CAN still suspend a normal user.
    expect(getByTestId("acceso-suspend")).toBeTruthy()
  })
})

describe("AccesoTab self / super target guards", () => {
  it("blocks changing your own role and suspending yourself", () => {
    const { getByTestId } = renderAcceso({ callerRole: "super", callerUserId: "u1" })
    expect(getByTestId("acceso-role-admin").getAttribute("aria-disabled")).toBe("true")
    expect(getByTestId("acceso-suspend").getAttribute("aria-disabled")).toBe("true")
  })

  it("can't suspend a super target", () => {
    const { getByTestId } = renderAcceso({ callerRole: "super", user: mkUser({ role: "super" }) })
    expect(getByTestId("acceso-suspend").getAttribute("aria-disabled")).toBe("true")
  })
})

describe("AccesoTab actions", () => {
  it("Suspender → confirm → updateUserStatus with exact args + patches the row", async () => {
    const onUpdate = vi.fn()
    const { getByTestId } = renderAcceso({ callerRole: "admin", onUpdate })

    fireEvent.click(getByTestId("acceso-suspend"))
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    await waitFor(() => expect(updateUserStatus).toHaveBeenCalledWith("u1", "suspended"))
    expect(updateUserStatus).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: "suspended" }))
  })
})

describe("AccesoTab step-up flow", () => {
  // Since 22261574e (auto-approve step-up for OAuth-only users) the component
  // tries `verifyStepUp({})` (no password) FIRST when it gets STEP_UP_REQUIRED,
  // and only shows the dialog when that auto-verification fails. These tests
  // pin the dialog path, so the auto-verify attempt must reject here.
  const makeAutoVerifyFail = () =>
    verifyStepUp.mockRejectedValueOnce(
      Object.assign(new Error("Password required"), { code: "PASSWORD_REQUIRED" }),
    )

  it("STEP_UP_REQUIRED → opens step-up dialog → verify → retries grantAccess", async () => {
    // First call rejects with STEP_UP_REQUIRED, second call succeeds.
    grantAccess
      .mockRejectedValueOnce(Object.assign(new Error("Step-up required"), { code: "STEP_UP_REQUIRED" }))
      .mockResolvedValueOnce({ user: { userId: "u1", accessGranted: true } })
    makeAutoVerifyFail()

    const onUpdate = vi.fn()
    const { getByTestId, queryByTestId } = renderAcceso({
      callerRole: "admin",
      user: mkUser({ accessGranted: false }),
      onUpdate,
    })

    // Click "Conceder acceso" — this sets pending state which opens ConfirmDialog.
    fireEvent.click(getByTestId("acceso-grant"))
    // Wait for the ConfirmDialog to render before clicking confirm. In CI
    // (shared runners) the state update + re-render may not complete
    // synchronously between two fireEvent.click calls.
    const confirmBtn = await waitFor(() => getByTestId("confirm-dialog-confirm"))
    fireEvent.click(confirmBtn)

    // grantAccess should have been called once and rejected with STEP_UP_REQUIRED
    await waitFor(() => expect(grantAccess).toHaveBeenCalledTimes(1))

    // The step-up dialog should appear — the async chain (grantAccess rejects →
    // verifyStepUp rejects → setStepUpOpen(true)) needs time to settle in CI.
    await waitFor(() => expect(getByTestId("stepup-dialog-backdrop")).toBeTruthy())

    // Type a password and verify
    const input = getByTestId("stepup-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "my-secret-password" } })
    fireEvent.click(getByTestId("stepup-confirm"))

    // verifyStepUp should be called with the password
    await waitFor(() =>
      expect(verifyStepUp).toHaveBeenCalledWith({ password: "my-secret-password" }),
    )

    // grantAccess should be retried after successful step-up
    await waitFor(() => expect(grantAccess).toHaveBeenCalledTimes(2))

    // The row should be patched with accessGranted: true
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ accessGranted: true }))

    // The step-up dialog should be gone
    await waitFor(() => expect(queryByTestId("stepup-dialog-backdrop")).toBeNull())
  })

  it("STEP_UP_REQUIRED → cancel step-up dialog → no retry", async () => {
    grantAccess.mockRejectedValueOnce(
      Object.assign(new Error("Step-up required"), { code: "STEP_UP_REQUIRED" }),
    )
    makeAutoVerifyFail()

    const onUpdate = vi.fn()
    const { getByTestId, queryByTestId } = renderAcceso({
      callerRole: "admin",
      user: mkUser({ accessGranted: false }),
      onUpdate,
    })

    // Click "Conceder acceso" — sets pending state which opens ConfirmDialog.
    fireEvent.click(getByTestId("acceso-grant"))
    // Wait for the ConfirmDialog to render before clicking confirm. In CI
    // (shared runners) the state update + re-render may not complete
    // synchronously between two fireEvent.click calls.
    const confirmBtn = await waitFor(() => getByTestId("confirm-dialog-confirm"))
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(grantAccess).toHaveBeenCalledTimes(1))

    // Step-up dialog appears — same async chain timing as the verify test.
    await waitFor(() => expect(getByTestId("stepup-dialog-backdrop")).toBeTruthy())

    // Cancel the step-up
    fireEvent.click(getByTestId("stepup-cancel"))

    // Dialog should close
    await waitFor(() => expect(queryByTestId("stepup-dialog-backdrop")).toBeNull())

    // verifyStepUp was called ONCE — the passwordless auto-verify attempt that
    // opened the dialog (22261574e) — and never with a password after cancel.
    expect(verifyStepUp).toHaveBeenCalledTimes(1)
    expect(verifyStepUp).toHaveBeenCalledWith({})

    // grantAccess should NOT have been retried
    expect(grantAccess).toHaveBeenCalledTimes(1)

    // onUpdate should NOT have been called
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
