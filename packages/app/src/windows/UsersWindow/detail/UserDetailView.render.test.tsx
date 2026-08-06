/**
 * UserDetailView — the tabbed per-user drill-in. Assertions that BITE:
 *   - it lazy-loads the enrichment on mount and, once resolved, the Resumen tab
 *     shows the real stats (loading → loaded transition),
 *   - if the enrichment REJECTS, the Resumen tab shows a recoverable inline error
 *     and the identity header is STILL rendered (the whole view is not blanked).
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/detail/UserDetailView.render.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import type { UserDetailEnrichment, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const getUserDetail = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  admin: { getUserDetail: (...a: unknown[]) => getUserDetail(...a), impersonate: vi.fn() },
  setSessionToken: vi.fn(),
  connect: vi.fn(),
}))
vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => clientMock }))
vi.mock("../../../store/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({
      user: { userId: "admin_1", role: "super", name: "Admin" },
      impersonation: null,
      startImpersonation: vi.fn(),
    }),
}))
vi.mock("../../../store/navbarStore", () => ({
  useNavbarStore: { getState: () => ({ reset: vi.fn() }) },
}))
vi.mock("../../../store/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ clearActiveWorkspace: vi.fn() }) },
}))
vi.mock("../../../store/tilingStore", () => ({
  useTilingStore: { getState: () => ({ resetState: vi.fn() }) },
}))

import { UserDetailView } from "./UserDetailView"

function mkUser(): UserSummary {
  return {
    userId: "u1",
    profile: { displayName: "Nora", email: "nora@x.io" },
    role: "user",
    status: "active",
    emailVerified: true,
    accessGranted: true,
    lastLoginAt: "2026-07-01T10:00:00Z",
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    providers: [],
    stats: { apps: 3, channels: 5 },
    activity: [],
    billing: null,
  } as UserSummary
}

const detail: UserDetailEnrichment = {
  userId: "u1",
  stats: { agents: 7, workspaces: 2, totalCost: 0, totalTokens: 0 },
  billing: null,
}

function renderView() {
  return renderWithTamagui(<UserDetailView user={mkUser()} onBack={() => {}} onUpdate={() => {}} />)
}

beforeEach(() => {
  getUserDetail.mockReset()
})

describe("UserDetailView", () => {
  it("lazy-loads the enrichment and shows the real stats once loaded", async () => {
    getUserDetail.mockImplementation(() => Promise.resolve(detail))
    const { findByText, getAllByText } = renderView()

    // Identity header renders immediately (crumb + identity row).
    expect(getAllByText("Nora").length).toBeGreaterThanOrEqual(1)
    // Enrichment resolves → agents KPI shows the real value.
    await findByText("7")
    expect(getUserDetail).toHaveBeenCalledWith("u1")
  })

  it("shows a recoverable inline error without blanking the view when the enrichment fails", async () => {
    getUserDetail.mockImplementation(() => Promise.reject(new Error("nope")))
    const { findByTestId, getAllByText } = renderView()

    await findByTestId("resumen-enrichment-error")
    // The identity header is still there — the view is not blanked.
    expect(getAllByText("Nora").length).toBeGreaterThanOrEqual(1)
  })
})
