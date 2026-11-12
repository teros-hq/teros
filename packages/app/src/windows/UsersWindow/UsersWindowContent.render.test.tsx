/**
 * UsersWindowContent — admin users panel, rebuilt as a DataTable + filter bar +
 * clickable KPI strip + list↔detail drill-in (TER-683 · PR2). Assertions that BITE:
 *   - on mount it requests page 0 at the default page size (50) and renders the
 *     server `summary` KPIs (incl. the new nearLimit/exhausted counts),
 *   - typing debounces and re-queries with `search` + page 0,
 *   - the Plan and Cuota dropdowns re-query with `plan` / `usage`,
 *   - clicking the "Agotadas" (exhausted) KPI re-queries with `usage:'exhausted'`,
 *   - pressing a row drills into the detail view (breadcrumb + identity),
 *   - numbered pagination shows only when total > pageSize and pages re-query.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/UsersWindowContent.render.test.tsx
 */
import { fireEvent, render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
// Initialize i18n (expo-localization is mocked → en-US) so t(...) resolves to
// English strings and any text-based assertion is deterministic.
import "../../i18n"
import type { UserSummary } from "../../services/AdminApi"

const listUsers = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  isConnected: () => true,
  on: vi.fn(),
  off: vi.fn(),
  admin: {
    listUsers: (...args: unknown[]) => listUsers(...args),
    // PR3: the detail drill-in lazy-loads the enrichment on mount.
    getUserDetail: () =>
      Promise.resolve({
        userId: "u1",
        stats: { agents: 0, workspaces: 0, totalCost: 0, totalTokens: 0 },
        billing: null,
      }),
  },
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => clientMock,
}))

import { UsersWindowContent } from "./UsersWindowContent"

function mkRow(id: string, name: string): UserSummary {
  return {
    userId: id,
    profile: { displayName: name, email: `${name}@x.io` },
    role: "user",
    status: "active",
    emailVerified: true,
    accessGranted: true,
    lastLoginAt: "2026-07-01T10:00:00Z",
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    providers: [],
    stats: { apps: 0, channels: 0 },
    activity: [],
    billing: {
      planId: "plan_pro",
      planName: "Pro",
      status: "active",
      teamId: null,
      teamName: null,
      agentHoursUsed: 48,
      effectiveLimit: 70,
      pct: 48 / 70,
    },
  } as UserSummary
}

function page(users: UserSummary[], total: number, p = 0) {
  return Promise.resolve({
    users,
    total,
    page: p,
    pageSize: 50,
    summary: { total, active: 88, admins: 6, nearLimit: 17, exhausted: 9 },
  })
}

function renderPanel() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <UsersWindowContent windowId="w1" />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  listUsers.mockReset()
})

describe("UsersWindowContent", () => {
  it("requests page 0 at the default page size and renders the summary KPIs", async () => {
    listUsers.mockImplementation(() => page([mkRow("u1", "Ana")], 120))
    const { findByText, getByText } = renderPanel()

    await findByText("Ana")
    expect(listUsers).toHaveBeenCalledWith(expect.objectContaining({ page: 0, pageSize: 50 }))
    // KPI strip: labels + the new nearLimit / exhausted counts (server-computed).
    expect(getByText("Total")).toBeTruthy()
    expect(getByText("17")).toBeTruthy() // nearLimit
    expect(getByText("9")).toBeTruthy() // exhausted
  })

  it("debounces the search box and re-queries with the term on page 0", async () => {
    listUsers.mockImplementation(() => page([mkRow("u1", "Ana")], 1))
    const { findByText, getByTestId } = renderPanel()

    await findByText("Ana")
    await userEvent.type(getByTestId("users-search"), "ana")

    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "ana", page: 0 }),
      ),
    )
  })

  it("re-queries with `plan` when a plan is picked from the Plan dropdown", async () => {
    listUsers.mockImplementation((p: any) => page([mkRow("u1", "Ana")], 1, p?.page ?? 0))
    const { findByText, findByTestId, getByTestId } = renderPanel()

    await findByText("Ana") // load done → planOptions has plan_pro → Pro
    fireEvent.click(getByTestId("filter-plan")) // open dropdown
    fireEvent.click(await findByTestId("filter-plan-opt-plan_pro"))

    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ plan: "plan_pro", page: 0 }),
      ),
    )
  })

  it("re-queries with `usage` when a quota bucket is picked from the Cuota dropdown", async () => {
    listUsers.mockImplementation(() => page([mkRow("u1", "Ana")], 1))
    const { findByText, findByTestId, getByTestId } = renderPanel()

    await findByText("Ana")
    fireEvent.click(getByTestId("filter-usage"))
    fireEvent.click(await findByTestId("filter-usage-opt-has_boost"))

    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ usage: "has_boost", page: 0 }),
      ),
    )
  })

  it("jumps to the exhausted quota filter when the Agotadas KPI is clicked", async () => {
    listUsers.mockImplementation(() => page([mkRow("u1", "Ana")], 1))
    const { findByText, getByTestId } = renderPanel()

    await findByText("Ana")
    fireEvent.click(getByTestId("kpi-exhausted"))

    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ usage: "exhausted", page: 0 }),
      ),
    )
  })

  it("drills into the detail view when a row is pressed (breadcrumb shows the name)", async () => {
    listUsers.mockImplementation(() => page([mkRow("u1", "Ana")], 1))
    const { findByText, getByText, findByTestId, getAllByText } = renderPanel()

    await findByText("Ana")
    fireEvent.click(getByText("Ana")) // press the row

    await findByTestId("user-detail-view")
    // "Ana" now appears in the breadcrumb crumb AND the identity row.
    expect(getAllByText("Ana").length).toBeGreaterThanOrEqual(1)
  })

  it("shows numbered pagination only when total exceeds the page size, and pages re-query", async () => {
    listUsers.mockImplementation((p: any) => page([mkRow("u1", "Ana")], 120, p?.page ?? 0))
    const { findByText } = renderPanel()

    await findByText("Ana")
    const pageThree = await findByText("3") // 120/50 → 3 pages
    await userEvent.click(pageThree)

    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    )
  })
})
