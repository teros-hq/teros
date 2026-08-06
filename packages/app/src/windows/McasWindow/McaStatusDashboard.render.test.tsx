/**
 * McaStatusDashboard — Health window render test (Phase 3 v1.0 + Phase 4 v2.0 redesign).
 *
 * Mirrors McasWindow.render.test.tsx: real i18n labels, TamaguiProvider dark, getTerosClient
 * mocked so the dashboard mounts without a backend.
 *
 * v1.0 assertions that still bite (Phase 3):
 *   - AC-3: the four summary labels (mca.status.summary.operational/.failed/.partial/.total)
 *     render and the counts match the persisted app.get-mca-health overlay (unmatched tools → pending),
 *   - AC-6: a catalog MCA with no persisted row renders a Pending overall badge and never throws,
 *   - DASH-02: exactly one row per catalog MCA (each MCA name appears once),
 *   - AC-4/DASH-04: pressing a row expands the read-only Tool / Status / Notes table.
 *
 * v2.0 assertions added for Phase 4 (HEALTH-01..05, I18N-03):
 *   - HEALTH-01/D-12: content-category grouping in fixed semantic order + Other bucket,
 *   - HEALTH-02/D-08: availability filter chips remove matching rows,
 *   - HEALTH-03/D-09/D-10: search filters within groups (debounced) and restores on clear,
 *   - HEALTH-05/D-05/D-06: segmented health bar — never-tested reads "Not tested" (neutral,
 *     not red/0%); a definitive mix renders a `passing/counted` fraction excluding pending/skip.
 *
 * The catalog is mocked via listAllMcas and per-tool statuses are driven through the persisted
 * app.get-mca-health overlay (the hoisted getMcaHealth mock); a tool with no persisted row
 * renders pending (the new default). listAllMcas MUST resolve { mcas: [...] } (NOT a bare array):
 * the component reads `(await client.app.listAllMcas()).mcas`.
 *
 *   cd packages/app && npx vitest run src/windows/McasWindow/McaStatusDashboard.render.test.tsx
 */
import { fireEvent, render, waitFor, within } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import i18n from "../../i18n"

// The dashboard fetches the catalog on mount via getTerosClient().app.listAllMcas().
// listAllMcas MUST resolve { mcas: [...] } (NOT a bare array): the component reads
// `(await client.app.listAllMcas()).mcas` then maps over it — a bare-array mock makes
// `.mcas` undefined and `undefined.map(...)` throws.
const listAllMcas = vi.hoisted(() => vi.fn())
// Phase 8 live-test path mocks (08-04 Task 3). onRetestPress → getMcaResolvability +
// getMcaToolSchemas → testMcaTool → writeHealth(recordMcaHealth). getMcaHealth is now the
// SOLE per-tool status source (seed retired, Phase 9): tests inject McaHealthRecord[] through
// it; an empty health array renders every catalog tool pending. Each is a spy so assertions can
// inspect the recordMcaHealth batch.
const getMcaResolvability = vi.hoisted(() => vi.fn())
const getMcaToolSchemas = vi.hoisted(() => vi.fn())
const testMcaTool = vi.hoisted(() => vi.fn())
const recordMcaHealth = vi.hoisted(() => vi.fn())
const getMcaHealth = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  isConnected: () => true,
  on: vi.fn(),
  off: vi.fn(),
  app: {
    listAllMcas: (...args: unknown[]) => listAllMcas(...args),
    getMcaResolvability: (...args: unknown[]) => getMcaResolvability(...args),
    getMcaToolSchemas: (...args: unknown[]) => getMcaToolSchemas(...args),
    testMcaTool: (...args: unknown[]) => testMcaTool(...args),
    recordMcaHealth: (...args: unknown[]) => recordMcaHealth(...args),
    getMcaHealth: (...args: unknown[]) => getMcaHealth(...args),
  },
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => clientMock,
}))

import { McaStatusDashboard } from "./McaStatusDashboard"

const summaryOperational = i18n.t("mca.status.summary.operational")
const summaryFailed = i18n.t("mca.status.summary.failed")
const summaryPartial = i18n.t("mca.status.summary.partial")
const summaryTotal = i18n.t("mca.status.summary.total")
const pendingLabel = i18n.t("mca.status.toolStatus.pending")

// Per-tool table labels (AC-4 / DASH-04 / DASH-05).
const colTool = i18n.t("mca.status.columns.tool")
const colStatus = i18n.t("mca.status.columns.status")
const colNotes = i18n.t("mca.status.columns.notes")
const toolOk = i18n.t("mca.status.toolStatus.ok")
const toolPending = i18n.t("mca.status.toolStatus.pending")
const toolFail = i18n.t("mca.status.toolStatus.fail")
const toolConfirm = i18n.t("mca.status.toolStatus.confirm")
const toolSkip = i18n.t("mca.status.toolStatus.skip")

// v2.0 Health window labels (Phase 4 — real i18n so the test also guards I18N-03).
const catProductivity = i18n.t("mca.status.categories.productivity")
const catDevelopment = i18n.t("mca.status.categories.development")
const catCommunication = i18n.t("mca.status.categories.communication")
const catData = i18n.t("mca.status.categories.data")
const catOther = i18n.t("mca.status.categories.other")
const filterHidden = i18n.t("mca.status.filters.hidden")
const notTestedLabel = i18n.t("mca.status.healthBar.notTested")
const searchPlaceholder = i18n.t("mca.status.searchPlaceholder")

// Phase 8 live-test labels (08-04 Task 3).
const retestLabel = i18n.t("mca.status.retestTool")

// mcaIds distinguish "has persisted rows" (statuses injected per-test via getMcaHealth) from
// "has none" (renders pending by default). Names are historical; no seed is consulted.
const OPERATIONAL_ID = "slack"
const MIXED_ID = "google-drive"
const UNPERSISTED_ID = "__no-persisted__"

function mcaCatalogEntry(
  mcaId: string,
  name: string,
  tools: string[] = ["tool-a", "tool-b"],
  overrides: {
    category?: string
    availability?: Partial<{
      enabled: boolean
      multi: boolean
      system: boolean
      hidden: boolean
      role: string
    }>
  } = {},
) {
  return {
    mcaId,
    name,
    description: `${name} test MCA`,
    category: overrides.category ?? "test",
    tools,
    availability: {
      enabled: true,
      multi: false,
      system: false,
      hidden: false,
      role: "user",
      ...(overrides.availability ?? {}),
    },
  }
}

function renderDashboard() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <McaStatusDashboard />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  listAllMcas.mockReset()
  getMcaResolvability.mockReset()
  getMcaToolSchemas.mockReset()
  testMcaTool.mockReset()
  recordMcaHealth.mockReset()
  getMcaHealth.mockReset()
  // Safe defaults for the live-test path (individual tests override as needed).
  getMcaResolvability.mockResolvedValue({ runnable: true })
  getMcaToolSchemas.mockResolvedValue({ tools: [] })
  testMcaTool.mockResolvedValue({ success: true, result: {} })
  recordMcaHealth.mockResolvedValue({ recorded: 1 })
  getMcaHealth.mockResolvedValue({ health: [] })
})

describe("McaStatusDashboard", () => {
  it("renders the four summary labels and a row per catalog MCA (AC-3, DASH-02)", async () => {
    listAllMcas.mockResolvedValue({
      mcas: [
        mcaCatalogEntry(OPERATIONAL_ID, "Op MCA"),
        mcaCatalogEntry(MIXED_ID, "Mixed MCA"),
        mcaCatalogEntry(UNPERSISTED_ID, "Unpersisted MCA"),
      ],
    })

    const { findAllByText } = renderDashboard()

    // AC-3: all four summary labels render.
    expect((await findAllByText(summaryOperational)).length).toBeGreaterThan(0)
    expect((await findAllByText(summaryFailed)).length).toBeGreaterThan(0)
    expect((await findAllByText(summaryPartial)).length).toBeGreaterThan(0)
    expect((await findAllByText(summaryTotal)).length).toBeGreaterThan(0)

    // DASH-02: one row per catalog MCA — each MCA name appears.
    expect((await findAllByText("Op MCA")).length).toBeGreaterThan(0)
    expect((await findAllByText("Mixed MCA")).length).toBeGreaterThan(0)
    expect((await findAllByText("Unpersisted MCA")).length).toBeGreaterThan(0)
  })

  it("derives the Total count from the catalog (AC-3)", async () => {
    listAllMcas.mockResolvedValue({
      mcas: [
        mcaCatalogEntry(OPERATIONAL_ID, "Op MCA"),
        mcaCatalogEntry(MIXED_ID, "Mixed MCA"),
        mcaCatalogEntry(UNPERSISTED_ID, "Unpersisted MCA"),
      ],
    })

    const { findAllByText } = renderDashboard()

    // Total = catalog count (3). The big number "3" must appear next to the Total label.
    expect((await findAllByText(summaryTotal)).length).toBeGreaterThan(0)
    expect((await findAllByText("3")).length).toBeGreaterThan(0)
  })

  it("renders a Pending badge for a catalog MCA with no persisted row and never throws (AC-6)", async () => {
    listAllMcas.mockResolvedValue({
      mcas: [
        mcaCatalogEntry(OPERATIONAL_ID, "Op MCA"),
        mcaCatalogEntry(UNPERSISTED_ID, "Unpersisted MCA"),
      ],
    })
    // Default health:[] (beforeEach) → no persisted rows for either MCA. Pending is now the
    // DEFAULT case: an MCA with no persisted health degrades to a Pending overall (never throws).

    const { findAllByText } = renderDashboard()

    // The unpersisted MCA's row renders with a Pending overall badge.
    expect((await findAllByText("Unpersisted MCA")).length).toBeGreaterThan(0)
    expect((await findAllByText(pendingLabel)).length).toBeGreaterThan(0)
  })

  describe("accordion expand + per-tool table (AC-4, DASH-03/04/05, AC-6 tool-level)", () => {
    // Catalog tool arrays chosen so the persisted overlay yields all five ToolTestStatus values.
    // The status per tool is injected through getMcaHealth (see mixedStatusHealth); any catalog
    // tool with no persisted row (e.g. __unpersisted-tool__) renders pending → AC-6 tool-level.
    //   gmail: read-email(ok), delete-email(confirm), __unpersisted-tool__(pending)
    //   google-drive: upload-file(fail)
    //   netlify: trigger-deploy(skip)
    function mixedStatusCatalog() {
      return {
        mcas: [
          mcaCatalogEntry("gmail", "Gmail MCA", [
            "read-email",
            "delete-email",
            "__unpersisted-tool__",
          ]),
          mcaCatalogEntry("google-drive", "Drive MCA", ["upload-file"]),
          mcaCatalogEntry("netlify", "Netlify MCA", ["trigger-deploy"]),
        ],
      }
    }
    // Persisted rows driving the four definitive statuses; __unpersisted-tool__ is intentionally
    // omitted so it degrades to pending (AC-6 tool-level). testedAt mirrors the backfill baseline.
    function mixedStatusHealth() {
      return {
        health: [
          { mcaId: "gmail", tool: "read-email", status: "ok", testedAt: "2026-06-30T00:00:00Z" },
          {
            mcaId: "gmail",
            tool: "delete-email",
            status: "confirm",
            testedAt: "2026-06-30T00:00:00Z",
          },
          {
            mcaId: "google-drive",
            tool: "upload-file",
            status: "fail",
            testedAt: "2026-06-30T00:00:00Z",
          },
          {
            mcaId: "netlify",
            tool: "trigger-deploy",
            status: "skip",
            testedAt: "2026-06-30T00:00:00Z",
          },
        ],
      }
    }

    it("keeps rows collapsed by default — no per-tool columns until expanded (DASH-03)", async () => {
      listAllMcas.mockResolvedValue(mixedStatusCatalog())
      const { findAllByText, queryByText } = renderDashboard()

      // Row is present…
      expect((await findAllByText("Gmail MCA")).length).toBeGreaterThan(0)
      // …but the per-tool table header is NOT rendered while collapsed.
      expect(queryByText(colTool)).toBeNull()
      expect(queryByText(colStatus)).toBeNull()
      expect(queryByText(colNotes)).toBeNull()
    })

    it("expands a row on header press to reveal a Tool / Status / Notes table (DASH-03/04)", async () => {
      listAllMcas.mockResolvedValue(mixedStatusCatalog())
      const { findAllByText, findByText } = renderDashboard()

      const [header] = await findAllByText("Gmail MCA")
      fireEvent.click(header)

      // Table header columns appear once expanded.
      expect(await findByText(colTool)).toBeTruthy()
      expect(await findByText(colStatus)).toBeTruthy()
      expect(await findByText(colNotes)).toBeTruthy()
      // One row per catalog tool of the expanded MCA.
      expect((await findAllByText("read-email")).length).toBeGreaterThan(0)
      expect((await findAllByText("delete-email")).length).toBeGreaterThan(0)
      expect((await findAllByText("__unpersisted-tool__")).length).toBeGreaterThan(0)
    })

    it("does not render a stale persisted error note for a recovered/ok tool (stale-note guard)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["post-message"], { category: "communication" }),
        ],
      })
      // A persisted OK record that still carries an error left over from a prior failed run (the
      // backend now $unsets it, but existing rows and any race can still surface one). The row must
      // render ok WITHOUT showing that stale error as a note.
      getMcaHealth.mockResolvedValue({
        health: [
          {
            mcaId: "slack",
            tool: "post-message",
            status: "ok",
            error: "stale boom from earlier",
            testedAt: "2026-06-30T00:00:00Z",
          },
        ],
      })
      const { findAllByText, queryByText } = renderDashboard()

      const [header] = await findAllByText("Slack MCA")
      fireEvent.click(header)

      // The tool row is present…
      expect((await findAllByText("post-message")).length).toBeGreaterThan(0)
      // …and the stale error text is rendered nowhere.
      expect(queryByText("stale boom from earlier")).toBeNull()
    })

    it("renders a readable per-tool last-tested timestamp (formatted, not raw ISO)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["post-message"], { category: "communication" }),
        ],
      })
      // Midday UTC so the calendar date can't roll across a day boundary in any test timezone.
      const iso = "2026-06-30T12:00:00.000Z"
      getMcaHealth.mockResolvedValue({
        health: [{ mcaId: "slack", tool: "post-message", status: "ok", testedAt: iso }],
      })
      const { findAllByText } = renderDashboard()

      const [header] = await findAllByText("Slack MCA")
      fireEvent.click(header)
      await findAllByText("post-message")

      // A readable "Tested … 2026" label renders (per-MCA summary line + per-tool sub-line),
      // localized via toLocaleString — never the raw ISO string.
      const tested = await findAllByText((content) => /Tested\b/.test(content) && /2026/.test(content))
      expect(tested.length).toBeGreaterThan(0)
      // The raw ISO must not leak into the DOM anywhere (that was the unreadable-timestamp bug).
      expect(document.body.textContent ?? "").not.toContain("2026-06-30T12:00:00")
    })

    it("renders all five tool statuses with distinct labels across expanded rows (DASH-05, AC-6)", async () => {
      listAllMcas.mockResolvedValue(mixedStatusCatalog())
      getMcaHealth.mockResolvedValue(mixedStatusHealth())
      const { findAllByText } = renderDashboard()

      // Expand all three rows.
      for (const name of ["Gmail MCA", "Drive MCA", "Netlify MCA"]) {
        const [header] = await findAllByText(name)
        fireEvent.click(header)
      }

      // All five ToolTestStatus labels render, each visually distinct (distinct label text):
      //   ok (read-email), confirm (delete-email), pending (__unpersisted-tool__ → AC-6 tool-level),
      //   fail (upload-file), skip (trigger-deploy).
      expect((await findAllByText(toolOk)).length).toBeGreaterThan(0)
      expect((await findAllByText(toolConfirm)).length).toBeGreaterThan(0)
      expect((await findAllByText(toolPending)).length).toBeGreaterThan(0)
      expect((await findAllByText(toolFail)).length).toBeGreaterThan(0)
      expect((await findAllByText(toolSkip)).length).toBeGreaterThan(0)
    })

    it("renders a catalog tool with no persisted row as Pending without throwing (AC-6 tool-level)", async () => {
      // Default health:[] (beforeEach) → neither tool has a persisted row, so both degrade to
      // pending. __ghost-tool__ specifically proves an un-persisted catalog tool never throws.
      listAllMcas.mockResolvedValue({
        mcas: [mcaCatalogEntry("gmail", "Gmail MCA", ["read-email", "__ghost-tool__"])],
      })
      const { findAllByText } = renderDashboard()

      const [header] = await findAllByText("Gmail MCA")
      fireEvent.click(header)

      expect((await findAllByText("__ghost-tool__")).length).toBeGreaterThan(0)
      expect((await findAllByText(toolPending)).length).toBeGreaterThan(0)
    })
  })

  // ── Phase 4 v2.0: content-category grouping (HEALTH-01, D-11/D-12) ──────────────────────
  describe("content-category grouping (HEALTH-01, D-11/D-12)", () => {
    it("groups MCAs under content-category headers and buckets unknown/missing into Other", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["tool-a"], { category: "communication" }),
          mcaCatalogEntry("github", "GitHub MCA", ["tool-a"], { category: "development" }),
          // Unknown category → Other bucket.
          mcaCatalogEntry("mystery", "Mystery MCA", ["tool-a"], { category: "not-a-real-cat" }),
          // Missing/empty category → Other bucket.
          mcaCatalogEntry("blank", "Blank MCA", ["tool-a"], { category: "" }),
        ],
      })

      const { findByText, findAllByText } = renderDashboard()

      // Known category headers render.
      expect(await findByText(catCommunication)).toBeTruthy()
      expect(await findByText(catDevelopment)).toBeTruthy()
      // Unknown + missing category MCAs both live under Other.
      expect(await findByText(catOther)).toBeTruthy()
      expect((await findAllByText("Mystery MCA")).length).toBeGreaterThan(0)
      expect((await findAllByText("Blank MCA")).length).toBeGreaterThan(0)
    })

    it("renders category headers in the fixed semantic order regardless of input order (D-12)", async () => {
      // Input order is deliberately out of semantic order: data, communication, development, productivity.
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("m-data", "Data MCA", ["tool-a"], { category: "data" }),
          mcaCatalogEntry("m-comm", "Comm MCA", ["tool-a"], { category: "communication" }),
          mcaCatalogEntry("m-dev", "Dev MCA", ["tool-a"], { category: "development" }),
          mcaCatalogEntry("m-prod", "Prod MCA", ["tool-a"], { category: "productivity" }),
        ],
      })

      const { findByText, container } = renderDashboard()
      // Wait for render to settle.
      await findByText(catProductivity)

      const bodyText = container.textContent ?? ""
      const idxProductivity = bodyText.indexOf(catProductivity)
      const idxDevelopment = bodyText.indexOf(catDevelopment)
      const idxCommunication = bodyText.indexOf(catCommunication)
      const idxData = bodyText.indexOf(catData)

      // CATEGORY_ORDER: productivity → development → communication → data.
      expect(idxProductivity).toBeGreaterThanOrEqual(0)
      expect(idxProductivity).toBeLessThan(idxDevelopment)
      expect(idxDevelopment).toBeLessThan(idxCommunication)
      expect(idxCommunication).toBeLessThan(idxData)
    })
  })

  // ── Phase 4 v2.0: availability filter chips (HEALTH-02, D-08) ───────────────────────────
  describe("availability filter chips (HEALTH-02, D-08)", () => {
    it("toggling the Hidden chip off removes hidden MCA rows", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("visible", "Visible MCA", ["tool-a"], { category: "communication" }),
          mcaCatalogEntry("secret", "Hidden MCA", ["tool-a"], {
            category: "communication",
            availability: { hidden: true },
          }),
        ],
      })

      const { findAllByText, findByText, queryByText } = renderDashboard()

      // Both rows visible initially.
      expect((await findAllByText("Visible MCA")).length).toBeGreaterThan(0)
      expect((await findAllByText("Hidden MCA")).length).toBeGreaterThan(0)

      // Toggle the Hidden chip off.
      const [hiddenChip] = await findAllByText(filterHidden)
      fireEvent.click(hiddenChip)

      // Hidden MCA disappears; visible MCA remains.
      await waitFor(() => expect(queryByText("Hidden MCA")).toBeNull())
      expect(await findByText("Visible MCA")).toBeTruthy()
    })
  })

  // ── Phase 4 v2.0: search within groups (HEALTH-03, D-09/D-10) ───────────────────────────
  describe("search filters within groups (HEALTH-03, D-09/D-10)", () => {
    it("filters bars within groups and drops now-empty categories, restoring on clear", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["tool-a"], { category: "communication" }),
          mcaCatalogEntry("github", "GitHub MCA", ["tool-a"], { category: "development" }),
        ],
      })

      const { findByPlaceholderText, findByText, queryByText } = renderDashboard()

      // Both category headers present initially.
      expect(await findByText(catCommunication)).toBeTruthy()
      expect(await findByText(catDevelopment)).toBeTruthy()

      const searchBox = await findByPlaceholderText(searchPlaceholder)

      // Search for "slack" — only the communication group survives.
      fireEvent.change(searchBox, { target: { value: "slack" } })
      await waitFor(() => expect(queryByText("GitHub MCA")).toBeNull())
      expect(await findByText("Slack MCA")).toBeTruthy()
      // The now-empty development category header is gone.
      expect(queryByText(catDevelopment)).toBeNull()

      // Clear the search — both restored.
      fireEvent.change(searchBox, { target: { value: "" } })
      await waitFor(() => expect(queryByText("GitHub MCA")).not.toBeNull())
      expect(await findByText(catDevelopment)).toBeTruthy()
    })

    it("matches against mcaId as well as display name (D-10)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Chat App", ["tool-a"], { category: "communication" }),
          mcaCatalogEntry("github", "Repo App", ["tool-a"], { category: "development" }),
        ],
      })

      const { findByPlaceholderText, findByText, queryByText } = renderDashboard()
      const searchBox = await findByPlaceholderText(searchPlaceholder)

      // Query matches the mcaId "github", not the display name.
      fireEvent.change(searchBox, { target: { value: "github" } })
      await waitFor(() => expect(queryByText("Chat App")).toBeNull())
      expect(await findByText("Repo App")).toBeTruthy()
    })
  })

  // ── Phase 4 v2.0: segmented health bar semantics (HEALTH-05, D-05/D-06) ─────────────────
  describe("segmented health bar (HEALTH-05, D-05/D-06)", () => {
    it("a never-tested MCA reads Not tested (neutral) rather than red/0%", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          // No persisted rows (default health:[]) → no definitive tool results → counted === 0.
          mcaCatalogEntry("__no-persisted__", "Fresh MCA", ["tool-a", "tool-b"], {
            category: "communication",
          }),
        ],
      })

      const { findByText, queryByText } = renderDashboard()

      // Not-tested affordance appears; no 0/x fraction implying failure.
      expect(await findByText(notTestedLabel)).toBeTruthy()
      expect(queryByText("0/2")).toBeNull()
      expect(queryByText("0/0")).toBeNull()
    })

    it("renders a passing/counted fraction excluding pending/skip from the denominator (D-05/D-06)", async () => {
      // Persisted rows: list-sites(ok), trigger-deploy(skip). Catalog exposes both tools plus an
      // un-persisted tool (pending). Definitive results: only list-sites(ok) → skip + pending excluded.
      // passing = 1, counted = 1 → fraction "1/1".
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry(
            "netlify",
            "Netlify MCA",
            ["list-sites", "trigger-deploy", "ghost-tool"],
            {
              category: "development",
            },
          ),
        ],
      })
      getMcaHealth.mockResolvedValue({
        health: [
          { mcaId: "netlify", tool: "list-sites", status: "ok", testedAt: "2026-06-30T00:00:00Z" },
          {
            mcaId: "netlify",
            tool: "trigger-deploy",
            status: "skip",
            testedAt: "2026-06-30T00:00:00Z",
          },
        ],
      })

      const { findByText } = renderDashboard()

      // 1 ok / 1 definitive (skip + pending excluded from the denominator).
      expect(await findByText("1/1")).toBeTruthy()
    })

    it("renders passing/counted for a mixed ok+fail MCA (D-06)", async () => {
      // Persisted rows: list-files(ok), download-file(ok), upload-file(fail).
      // Catalog exposes all three → passing = 2, counted = 3 → fraction "2/3".
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry(
            "google-drive",
            "Drive MCA",
            ["list-files", "download-file", "upload-file"],
            {
              category: "data",
            },
          ),
        ],
      })
      getMcaHealth.mockResolvedValue({
        health: [
          {
            mcaId: "google-drive",
            tool: "list-files",
            status: "ok",
            testedAt: "2026-06-30T00:00:00Z",
          },
          {
            mcaId: "google-drive",
            tool: "download-file",
            status: "ok",
            testedAt: "2026-06-30T00:00:00Z",
          },
          {
            mcaId: "google-drive",
            tool: "upload-file",
            status: "fail",
            testedAt: "2026-06-30T00:00:00Z",
          },
        ],
      })

      const { findByText } = renderDashboard()

      expect(await findByText("2/3")).toBeTruthy()
    })
  })

  // ── Phase 8 08-04: error surfacing + read-only classification (TEST-04, T-08-04) ────────
  describe("live-test error surfacing + read-only classification (08-04)", () => {
    const confirmRunLabel = i18n.t("mca.status.confirm.run")

    // Expand a row and press its per-tool Retest control, awaiting the async run path to settle.
    async function expandAndRetest(helpers: ReturnType<typeof renderDashboard>, mcaName: string) {
      const [header] = await helpers.findAllByText(mcaName)
      fireEvent.click(header)
      const retestBtns = await helpers.findAllByText(retestLabel)
      fireEvent.click(retestBtns[0])
    }

    // Retest an unannotated (→ destructive) tool: the per-tool Retest now routes through the shared
    // destructive confirm (#2), so advance it by pressing Run before the tool actually executes.
    async function expandRetestConfirm(helpers: ReturnType<typeof renderDashboard>, mcaName: string) {
      await expandAndRetest(helpers, mcaName)
      const runBtn = await helpers.findByText(confirmRunLabel)
      fireEvent.click(runBtn)
    }

    it("surfaces the backend-returned error message on a failed Retest row (Test 1)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["send-message"], { category: "communication" }),
        ],
      })
      // A zero-input tool → immediate run (no Sheet). Backend returns the explicit error field.
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "send-message",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: false, error: "boom: missing token" })

      const helpers = renderDashboard()
      await expandRetestConfirm(helpers, "Slack MCA")

      // The row's Notes shows the real message (run.error === "{{message}}"). Its presence proves
      // the message path won over the generic constant (which would render exactly "Failed" in the
      // Notes cell — "Failed" still appears as the summary-card label, so a global negative check
      // would be a false positive; the message's presence is the load-bearing assertion).
      expect(await helpers.findByText("boom: missing token")).toBeTruthy()
    })

    it("persists the real error message (not the generic label) through recordMcaHealth (Test 2)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["send-message"], { category: "communication" }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "send-message",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: false, error: "boom: missing token" })

      const helpers = renderDashboard()
      await expandRetestConfirm(helpers, "Slack MCA")

      // The write-through batch carries status:"fail" + error === the returned message.
      await waitFor(() => expect(recordMcaHealth).toHaveBeenCalled())
      const batch = recordMcaHealth.mock.calls.at(-1)?.[0] as Array<{
        mcaId: string
        tool: string
        status: string
        error?: string
      }>
      const entry = batch.find((b) => b.tool === "send-message")
      expect(entry?.status).toBe("fail")
      expect(entry?.error).toBe("boom: missing token")
    })

    // MAJOR (PR #347): extractErrorMessage has four branches — explicit `error`
    // wire field (Test 1), then a fallback over `result`: a raw string, or an
    // object's `message ?? error ?? text`, else nothing (generic "Failed" label +
    // no persisted error). Test 1 covered only the first. These cover the rest so a
    // dropped/typo'd branch (e.g. `.message ?? .eror`) turns a suite red. Each drives
    // the SAME runSingleTool path Test 1/2 use and asserts BOTH the rendered Notes
    // and the persisted `error` (the two consumers of the extracted string).
    async function retestFail(res: unknown) {
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["send-message"], { category: "communication" }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          { tool: "send-message", inputSchema: { type: "object", properties: {} }, requiresInput: false },
        ],
      })
      testMcaTool.mockResolvedValue(res)
      const helpers = renderDashboard()
      await expandRetestConfirm(helpers, "Slack MCA")
      return helpers
    }

    async function persistedError(): Promise<string | undefined> {
      await waitFor(() => expect(recordMcaHealth).toHaveBeenCalled())
      const batch = recordMcaHealth.mock.calls.at(-1)?.[0] as Array<{
        tool: string
        status: string
        error?: string
      }>
      const entry = batch.find((b) => b.tool === "send-message")
      expect(entry?.status).toBe("fail")
      return entry?.error
    }

    it("falls back to a raw-string `result` when no explicit error field is present (Test 1b)", async () => {
      // { success:false, result:"raw" } — no `error` field, so extraction reads `result`.
      const helpers = await retestFail({ success: false, result: "raw failure text" })
      expect(await helpers.findByText("raw failure text")).toBeTruthy()
      expect(await persistedError()).toBe("raw failure text")
    })

    it("extracts `.message` from an object `result` (Test 1c)", async () => {
      const helpers = await retestFail({ success: false, result: { message: "object message wins" } })
      expect(await helpers.findByText("object message wins")).toBeTruthy()
      expect(await persistedError()).toBe("object message wins")
    })

    it("extracts `.error` from an object `result` when `.message` is absent (Test 1d)", async () => {
      const helpers = await retestFail({ success: false, result: { error: "object error field" } })
      expect(await helpers.findByText("object error field")).toBeTruthy()
      expect(await persistedError()).toBe("object error field")
    })

    it("extracts `.text` from an object `result` when `.message`/`.error` are absent (Test 1e)", async () => {
      const helpers = await retestFail({ success: false, result: { text: "object text field" } })
      expect(await helpers.findByText("object text field")).toBeTruthy()
      expect(await persistedError()).toBe("object text field")
    })

    it("renders the generic Failed label and persists NO error when nothing carries text (Test 1f)", async () => {
      // An object with none of message/error/text → extraction returns undefined, so the
      // row shows the generic label and the write-through omits the error field entirely
      // (proves the fallback branch; a mutation that returned a stray string would persist one).
      const helpers = await retestFail({ success: false, result: { code: 500 } })
      // The tool row renders (Notes = generic "Failed" via run.failed).
      expect((await helpers.findAllByText("send-message")).length).toBeGreaterThan(0)
      expect(await persistedError()).toBeUndefined()
    })

    it("non-flat required-input tool: Sheet prefills the schema template and never fires with missing required input (raw-JSON gate)", async () => {
      // A save-conversation-shaped tool: required string fields + optional arrays. The arrays make
      // the schema non-flat → the raw-JSON editor path. Before the gate, submitting the empty box
      // ({} ) fired the tool with undefined required fields → opaque MCA crash (undefined.length).
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("memory", "Memory MCA", ["save-conversation"], { category: "memory" }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "save-conversation",
            requiresInput: true,
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: {
                userMessage: { type: "string" },
                assistantResponse: { type: "string" },
                filesModified: { type: "array", items: { type: "string" }, default: [] },
              },
              required: ["userMessage", "assistantResponse"],
            },
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: true, result: {} })

      const helpers = renderDashboard()
      await expandAndRetest(helpers, "Memory MCA")

      // Sheet opens; the raw-JSON textarea is prefilled with the schema shape (required keys visible,
      // optional array seeded from its default), NOT an empty box.
      await helpers.findByText(i18n.t("mca.status.form.title", { tool: "save-conversation" }))
      // The Sheet renders through a portal (outside helpers.container), so query the document.
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement
      expect(textarea).not.toBeNull()
      expect(textarea.value).toContain("userMessage")
      expect(textarea.value).toContain("assistantResponse")
      expect(textarea.value).toContain("filesModified")

      // The prefilled template leaves required strings empty → Submit must not run the tool.
      const [submitBtn] = await helpers.findAllByText(i18n.t("mca.status.form.submit"))
      fireEvent.click(submitBtn)
      expect(testMcaTool.mock.calls.some((c) => c[1] === "save-conversation")).toBe(false)

      // Fill the required fields → Submit now runs the tool exactly once with the provided input.
      fireEvent.change(textarea, {
        target: {
          value: JSON.stringify({
            userMessage: "hi",
            assistantResponse: "hello",
            filesModified: [],
          }),
        },
      })
      const [submitBtn2] = await helpers.findAllByText(i18n.t("mca.status.form.submit"))
      fireEvent.click(submitBtn2)
      await waitFor(() =>
        expect(testMcaTool.mock.calls.some((c) => c[1] === "save-conversation")).toBe(true),
      )
      const call = testMcaTool.mock.calls.find((c) => c[1] === "save-conversation")
      expect(call?.[2]).toEqual({ userMessage: "hi", assistantResponse: "hello", filesModified: [] })
    })

    it("classifies a manifest readOnlyHint:true tool as read-only despite a destructive-sounding name (Test 3)", async () => {
      // A tool whose name ("delete-stale-cache") reads destructive under the heuristic, but whose
      // manifest annotations declare readOnlyHint:true. Whole-MCA Test must run it in the read-only
      // pass (testMcaTool called) rather than gating it behind the destructive confirm.
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["delete-stale-cache"], {
            category: "communication",
          }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "delete-stale-cache",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: true },
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: true, result: {} })

      const helpers = renderDashboard()
      // Press the whole-MCA "Test" control (the header run button), then confirm the read-only
      // tool ran (testMcaTool called) without a destructive confirm intervening.
      const runBtns = await helpers.findAllByText(i18n.t("mca.status.test"))
      fireEvent.click(runBtns[0])

      await waitFor(() =>
        expect(testMcaTool.mock.calls.some((c) => c[1] === "delete-stale-cache")).toBe(true),
      )
    })

    it("a non-runnable MCA never starts a run and shows Install-to-test (D-13 guard + badge)", async () => {
      // MAJOR (PR #347): both the whole-MCA "non-runnable never starts" guard
      // (useMcaWholeRun: `if (resolvability?.runnable === false) return`) and the
      // "Install to test" badge (McaToolTable, nonRunnable branch) were untested —
      // mutating either stayed green. Pressing Test with an EMPTY resolvability cache
      // (button still enabled) drives runWholeMca, whose guard fetches runnable:false
      // and returns BEFORE any tool runs; onTest force-expands the row, and the now
      // runnable:false cache renders the localized install-to-test badge.
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["read-a"], { category: "communication" }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "read-a",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: true },
          },
        ],
      })
      getMcaResolvability.mockResolvedValue({ runnable: false, reason: "not-installed" })

      const { findAllByText, findByText } = renderDashboard()
      const [runBtn] = await findAllByText(i18n.t("mca.status.test"))
      fireEvent.click(runBtn)

      // The guard probed resolvability…
      await waitFor(() => expect(getMcaResolvability).toHaveBeenCalled())
      // …and the localized install-to-test badge renders on the force-expanded row.
      expect(await findByText(i18n.t("mca.status.nonRunnable.installToTest"))).toBeTruthy()
      // No tool ever ran — the run stopped at the guard, never reaching testMcaTool.
      expect(testMcaTool).not.toHaveBeenCalled()
    })
  })

  // ── Phase 8 08-05: whole-MCA serialization + per-tool cancel-continue (TEST-01/02) ──────
  describe("whole-MCA serialization + cancel-continue (08-05)", () => {
    const testLabel = i18n.t("mca.status.test")
    const formTitleFor = (tool: string) => i18n.t("mca.status.form.title", { tool })
    const formCancel = i18n.t("mca.status.form.cancel")
    const confirmTitle = i18n.t("mca.status.confirm.title")
    const confirmCancel = i18n.t("mca.status.confirm.cancel")

    // Two read-only tools that REQUIRE input (open the Sheet) + one destructive tool. A tool is
    // read-only iff annotations.readOnlyHint === true; unannotated non-read-only → destructive.
    // "input-a"/"input-b" require a `q` field so the input Sheet opens for each; "wipe-all" is
    // destructive (no readOnly annotation) so it lands behind the destructive confirm.
    function serializationCatalog() {
      return {
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["input-a", "input-b", "wipe-all"], {
            category: "communication",
          }),
        ],
      }
    }
    const requiresQ = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    }
    function serializationSchemas() {
      return {
        tools: [
          {
            tool: "input-a",
            inputSchema: requiresQ,
            requiresInput: true,
            annotations: { readOnlyHint: true },
          },
          {
            tool: "input-b",
            inputSchema: requiresQ,
            requiresInput: true,
            annotations: { readOnlyHint: true },
          },
          {
            tool: "wipe-all",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      }
    }

    it("opens exactly one input Sheet at a time during a whole-MCA run (TEST-01)", async () => {
      listAllMcas.mockResolvedValue(serializationCatalog())
      getMcaToolSchemas.mockResolvedValue(serializationSchemas())

      const { findAllByText, queryByText } = renderDashboard()
      const [runBtn] = await findAllByText(testLabel)
      fireEvent.click(runBtn)

      // The first input-requiring read-only tool ("input-a") opens its Sheet.
      await waitFor(() => expect(queryByText(formTitleFor("input-a"))).not.toBeNull())
      // The SECOND tool's Sheet is NOT open yet — serialization holds the loop on tool 1.
      expect(queryByText(formTitleFor("input-b"))).toBeNull()
    })

    it("a per-tool Cancel skips only that tool and continues to the next (TEST-01/02)", async () => {
      listAllMcas.mockResolvedValue(serializationCatalog())
      getMcaToolSchemas.mockResolvedValue(serializationSchemas())

      const { findAllByText, findByText, queryByText } = renderDashboard()
      const [runBtn] = await findAllByText(testLabel)
      fireEvent.click(runBtn)

      // First Sheet (input-a) opens.
      await findByText(formTitleFor("input-a"))
      // Cancel it — this tool is skipped (testMcaTool NOT called for it) and the loop advances.
      const [cancelBtn] = await findAllByText(formCancel)
      fireEvent.click(cancelBtn)

      // The run continues to the second input-requiring tool: its Sheet now opens.
      await waitFor(() => expect(queryByText(formTitleFor("input-b"))).not.toBeNull())
      // input-a was cancelled, so it never ran.
      expect(testMcaTool.mock.calls.some((c) => c[1] === "input-a")).toBe(false)
    })

    it("destructive-confirm Cancel keeps read-only results and skips (does not run) destructive tools (TEST-02)", async () => {
      // "read-now" is a zero-input read-only tool that runs immediately (produces an ok result);
      // "wipe-all" is destructive. After the read-only pass, cancelling the destructive confirm must
      // KEEP read-now's ok result and NOT run wipe-all, and wipe-all must stay in the row list.
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["read-now", "wipe-all"], {
            category: "communication",
          }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "read-now",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: true },
          },
          {
            tool: "wipe-all",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: true, result: {} })

      const { findAllByText, findByText, queryByText } = renderDashboard()
      const [runBtn] = await findAllByText(testLabel)
      fireEvent.click(runBtn)

      // The read-only tool ran during the read-only pass, then the destructive-confirm appears.
      await waitFor(() =>
        expect(testMcaTool.mock.calls.some((c) => c[1] === "read-now")).toBe(true),
      )
      await waitFor(() => expect(queryByText(confirmTitle)).not.toBeNull())

      // Scope the Cancel press to the confirm Sheet (the input Sheet shares the "Cancel" label,
      // though it is closed here; scoping keeps the assertion robust).
      const confirmHeading = await findByText(confirmTitle)
      const confirmSheet = confirmHeading.closest("div")?.parentElement ?? document.body
      const cancelInConfirm = within(confirmSheet).getAllByText(confirmCancel)[0]
      fireEvent.click(cancelInConfirm)

      // Confirm closes; the destructive tool never ran and stays in the row list (not dropped).
      await waitFor(() => expect(queryByText(confirmTitle)).toBeNull())
      expect(testMcaTool.mock.calls.some((c) => c[1] === "wipe-all")).toBe(false)
      expect((await findAllByText("wipe-all")).length).toBeGreaterThan(0)
      // The read-only result is preserved on its row: read-now shows the ok status label.
      const readNowLabel = await findByText("read-now")
      const readNowRow = readNowLabel.closest("div")?.parentElement ?? document.body
      expect(within(readNowRow).getAllByText(toolOk).length).toBeGreaterThan(0)
    })

    it("a second Test press during an in-flight whole-MCA run is a no-op (button-disable path)", async () => {
      // Covers the UI defense: mid-run `runningMcas` flips `testDisabled` true, so the second press
      // lands on a disabled button and never re-enters runWholeMca — no double execution / double
      // write-through. (The SYNCHRONOUS runningMcasRef guard, which catches a same-tick double-fire
      // before React can disable the button, is covered directly in useMcaWholeRun.render.test.tsx.)
      listAllMcas.mockResolvedValue({
        mcas: [
          mcaCatalogEntry("slack", "Slack MCA", ["slow-read"], { category: "communication" }),
        ],
      })
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "slow-read",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: true },
          },
        ],
      })
      // Hold the first run in flight until we release it.
      let release: () => void = () => {}
      testMcaTool.mockImplementation(
        () =>
          new Promise((res) => {
            release = () => res({ success: true, result: {} })
          }),
      )

      const { findAllByText } = renderDashboard()
      const [runBtn] = await findAllByText(testLabel)
      fireEvent.click(runBtn)
      await waitFor(() => expect(testMcaTool).toHaveBeenCalledTimes(1))

      // Second press while the first run is still awaiting its tool result. The re-entrancy guard
      // (runningMcasRef) rejects it SYNCHRONOUSLY — runWholeMca returns before its first await — so a
      // second run can never reach testMcaTool.
      fireEvent.click(runBtn)
      release()

      // Deterministic settle (no wait-and-hope real timer): recordMcaHealth fires at the end of the
      // first run's write-through, proving it completed. A wrongly-started second run would have
      // incremented the call count by then; assert exactly one execution.
      await waitFor(() => expect(recordMcaHealth).toHaveBeenCalled())
      expect(testMcaTool.mock.calls.filter((c) => c[1] === "slow-read")).toHaveLength(1)
    })
  })

  // ── live overall recompute — badge + summary track live results (PR #405 stale-badge fix) ───────
  describe("live overall recompute (stale-badge fix)", () => {
    const testLabel = i18n.t("mca.status.test")
    const installToTest = i18n.t("mca.status.nonRunnable.installToTest")

    // Climb from a node to the nearest ancestor that holds the whole-MCA Test button — the row bar.
    // Scoping badge queries to it excludes the top summary cards (which carry no Test button), so a
    // `summary.operational`/`.failed` text query hits the ROW's overall badge, not the summary label.
    function rowOf(node: HTMLElement): HTMLElement {
      let el: HTMLElement | null = node
      while (el && within(el).queryAllByText(testLabel).length === 0) el = el.parentElement
      return el ?? document.body
    }

    // A summary card renders "<value><label>" as two Texts in one YStack; read its numeric value.
    function summaryValue(label: string): string {
      const [labelNode] = within(document.body).getAllByText(label)
      const card = labelNode.parentElement as HTMLElement
      return (card.textContent ?? "").replace(label, "").trim()
    }

    it("recomputes the row badge AND the summary from a live Retest, without a reload", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [mcaCatalogEntry("slack", "Slack MCA", ["read-x"], { category: "communication" })],
      })
      // Persisted ok → loads Operational (summary: 1 operational, 0 failed).
      getMcaHealth.mockResolvedValue({
        health: [{ mcaId: "slack", tool: "read-x", status: "ok", testedAt: "2026-06-30T00:00:00Z" }],
      })
      // Zero-input read-only tool → Retest runs immediately (no destructive confirm, no input Sheet).
      getMcaToolSchemas.mockResolvedValue({
        tools: [
          {
            tool: "read-x",
            inputSchema: { type: "object", properties: {} },
            requiresInput: false,
            annotations: { readOnlyHint: true },
          },
        ],
      })
      testMcaTool.mockResolvedValue({ success: false, error: "boom now" })

      const { findAllByText } = renderDashboard()

      // Load-time: the row overall badge reads Operational; summary Operational 1 / Failed 0.
      const [name] = await findAllByText("Slack MCA")
      await waitFor(() => expect(within(rowOf(name)).queryByText(summaryOperational)).not.toBeNull())
      expect(summaryValue(summaryOperational)).toBe("1")
      expect(summaryValue(summaryFailed)).toBe("0")

      // Expand + Retest; the live run returns a failure.
      fireEvent.click(name)
      const retestBtns = await findAllByText(retestLabel)
      fireEvent.click(retestBtns[0])

      // The row badge recomputes to Failed (not the stale load-time Operational)…
      const [nameAfter] = await findAllByText("Slack MCA")
      await waitFor(() =>
        expect(within(rowOf(nameAfter)).queryByText(summaryFailed)).not.toBeNull(),
      )
      expect(within(rowOf(nameAfter)).queryByText(summaryOperational)).toBeNull()
      // …and the summary counters move with it: Operational 1→0, Failed 0→1.
      await waitFor(() => expect(summaryValue(summaryFailed)).toBe("1"))
      expect(summaryValue(summaryOperational)).toBe("0")
    })

    it("does not render the Install-to-test badge on a runnable expanded row (badge absence)", async () => {
      listAllMcas.mockResolvedValue({
        mcas: [mcaCatalogEntry("slack", "Slack MCA", ["read-x"], { category: "communication" })],
      })
      getMcaResolvability.mockResolvedValue({ runnable: true })

      const { findAllByText, queryByText } = renderDashboard()
      const [header] = await findAllByText("Slack MCA")
      fireEvent.click(header) // expand → probes resolvability (runnable:true)

      await waitFor(() => expect(getMcaResolvability).toHaveBeenCalled())
      // A runnable MCA must NOT show the non-runnable badge (kills an always-render mutant).
      expect(queryByText(installToTest)).toBeNull()
    })
  })
})
