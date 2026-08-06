/**
 * ResumenTab — read-only overview. Assertions that BITE:
 *   - loading: the enrichment KPIs (agents/workspaces/cost/tokens) show the "…"
 *     placeholder while apps/conversations (from the row) already show values,
 *   - loaded: the enrichment KPIs show the real formatted values,
 *   - error: a RECOVERABLE inline banner shows AND the row-derived data still
 *     renders (the view is NOT blanked).
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/detail/ResumenTab.render.test.tsx
 */
import { describe, expect, it } from "vitest"
import "../../../i18n"
import type { UserDetailEnrichment, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { ResumenTab } from "./ResumenTab"

function mkUser(): UserSummary {
  return {
    userId: "u1",
    profile: { displayName: "Ana", email: "ana@x.io" },
    role: "user",
    status: "active",
    badges: ["founding_partner"],
    emailVerified: true,
    accessGranted: true,
    lastLoginAt: "2026-07-01T10:00:00Z",
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    providers: [{ providerType: "anthropic-oauth", displayName: "Claude", status: "active" }],
    stats: { apps: 3, channels: 5 },
    activity: [
      { date: "2026-06-25", count: 1 },
      { date: "2026-06-26", count: 4 },
      { date: "2026-06-27", count: 2 },
    ],
    billing: null,
  } as UserSummary
}

const detail: UserDetailEnrichment = {
  userId: "u1",
  stats: { agents: 7, workspaces: 2, totalCost: 12.5, totalTokens: 1_234_567 },
  billing: null,
}

describe("ResumenTab", () => {
  it("shows the '…' placeholder for the enrichment KPIs while loading", () => {
    const { getAllByText, getByText } = renderWithTamagui(
      <ResumenTab user={mkUser()} detail={null} loading error={null} onRetry={() => {}} />,
    )
    // agents/workspaces/cost/tokens are all pending → four placeholders.
    expect(getAllByText("…").length).toBe(4)
    // Row-derived KPIs already have values.
    expect(getByText("3")).toBeTruthy() // apps
    expect(getByText("5")).toBeTruthy() // conversations
  })

  it("shows the real enrichment values once loaded", () => {
    const { getByText, queryByText } = renderWithTamagui(
      <ResumenTab
        user={mkUser()}
        detail={detail}
        loading={false}
        error={null}
        onRetry={() => {}}
      />,
    )
    expect(queryByText("…")).toBeNull()
    expect(getByText("7")).toBeTruthy() // agents
    expect(getByText("$12.50")).toBeTruthy() // cost
    expect(getByText("1.2M")).toBeTruthy() // tokens (compact)
  })

  it("shows a recoverable inline error without blanking the row data", () => {
    const { getByTestId, getByText } = renderWithTamagui(
      <ResumenTab user={mkUser()} detail={null} loading={false} error="boom" onRetry={() => {}} />,
    )
    expect(getByTestId("resumen-enrichment-error")).toBeTruthy()
    expect(getByTestId("resumen-enrichment-retry")).toBeTruthy()
    // The row-derived KPIs still render — the view is not blanked.
    expect(getByText("3")).toBeTruthy()
  })
})
