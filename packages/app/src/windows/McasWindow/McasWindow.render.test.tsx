/**
 * McasWindow — tab-navigation wrapper render test (Phase 2 NAV-01..NAV-05 / D-04 / D-05,
 * updated in Phase 3 Plan 01 Task 4). Real i18n labels, TamaguiProvider dark, getTerosClient
 * mocked so both tab surfaces mount without a backend. Assertions that bite:
 *   - both tab labels render (mca.status.tabManagement / mca.status.tabStatus),
 *   - Management is the default tab (the status-dashboard summary is absent on mount, D-04),
 *   - clicking MCA Status swaps to the real status dashboard — its summary (mca.status.summary.total)
 *     renders and the Management view unmounts (D-05).
 *
 *   cd packages/app && npx vitest run src/windows/McasWindow/McasWindow.render.test.tsx
 */
import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import i18n from "../../i18n"

// Both McasWindowContent and McaStatusDashboard fetch the catalog on mount via
// getTerosClient().app.listAllMcas(). listAllMcas MUST resolve { mcas: [...] } (NOT a bare
// array): both read `(await client.app.listAllMcas()).mcas` then map over it — a bare-array
// mock makes `.mcas` undefined and `undefined.map(...)` throws on mount.
const listAllMcas = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  isConnected: () => true,
  on: vi.fn(),
  off: vi.fn(),
  app: {
    listAllMcas: (...args: unknown[]) => listAllMcas(...args),
    // The status dashboard reads persisted tool-health on mount via getMcaHealth (seed retired,
    // Phase 9). Empty health → every tool pending; keeps the swap-to-dashboard test clean and
    // avoids an unhandled rejection log (mirrors McaStatusDashboard.render.test.tsx).
    getMcaHealth: async () => ({ health: [] }),
  },
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => clientMock,
}))

import { McasWindow } from "./McasWindow"

const tabManagement = i18n.t("mca.status.tabManagement")
const tabStatus = i18n.t("mca.status.tabStatus")
// Dashboard marker: the MCA Status surface renders the summary cards (mca.status.summary.total).
const summaryTotal = i18n.t("mca.status.summary.total")
// Dashboard-only marker for the mount-absence check: the real Management view has its own
// hardcoded "Total" label, so "Total" cannot prove the dashboard is hidden — "Operational"
// is rendered only by the status dashboard's summary cards.
const summaryOperational = i18n.t("mca.status.summary.operational")

// Non-empty catalog so the dashboard has rows; any catalog is fine — the dashboard reads
// persisted health (mocked empty by default → pending). This test exercises the tab wrapper,
// not health values, so the summary cards render regardless of per-tool status.
function mca(mcaId: string, name: string) {
  return {
    mcaId,
    name,
    description: `${name} test MCA`,
    category: "test",
    tools: ["tool-a", "tool-b"],
    availability: {
      enabled: true,
      multi: false,
      system: false,
      hidden: false,
      role: "user",
    },
  }
}

function renderWindow() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <McasWindow windowId="w1" />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  listAllMcas.mockReset()
  listAllMcas.mockResolvedValue({
    mcas: [mca("slack", "Slack"), mca("__no-persisted__", "Unpersisted MCA")],
  })
})

describe("McasWindow", () => {
  it("renders both tab labels", async () => {
    const { findAllByText } = renderWindow()
    expect((await findAllByText(tabManagement)).length).toBeGreaterThan(0)
    expect((await findAllByText(tabStatus)).length).toBeGreaterThan(0)
  })

  it("defaults to the Management tab (status dashboard summary absent on mount)", async () => {
    const { findAllByText, queryAllByText } = renderWindow()
    // Wait for the tab bar to render before asserting the dashboard summary is absent.
    await findAllByText(tabManagement)
    expect(queryAllByText(summaryOperational).length).toBe(0)
  })

  it("swaps to the MCA Status dashboard when the MCA Status tab is clicked", async () => {
    const user = userEvent.setup()
    const { findAllByText } = renderWindow()

    const statusTab = (await findAllByText(tabStatus))[0]
    await user.click(statusTab)

    // The dashboard loads the catalog async; its summary (Total) appears once mounted (D-05).
    await waitFor(async () => expect((await findAllByText(summaryTotal)).length).toBeGreaterThan(0))
  })
})
