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
const clientMock = vi.hoisted(() => ({
  admin: {
    updateUserStatus: (...a: unknown[]) => updateUserStatus(...a),
    updateUserRole: (...a: unknown[]) => updateUserRole(...a),
    grantAccess: (...a: unknown[]) => grantAccess(...a),
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
