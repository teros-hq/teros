/**
 * Curated "Google Suite" catalog group (prototype, frontend-only).
 *
 * Five of the nine apps (gmail/calendar/drive/contacts/forms) already exist in
 * the backend catalog and are only re-tagged into the `google` category for
 * grouping. The other four (analytics/docs/sheets/slides) don't exist yet, so we
 * ship their full catalog detail here — inline SVG logos + human-readable,
 * grouped tools in the same shape the sync produces (TER-538) — so both the list
 * card and the detail page render them exactly like a real catalog app.
 *
 * Kept in the frontend (not the DB) so `yarn sync` can't wipe it.
 */

import type { AppAuthInfo, CatalogMcaDetail } from "../../services/AppApi"

// The order the Google Suite cards render in (list). The five real apps are
// pulled from the backend catalog by these ids; the four below are local.
export const GOOGLE_SUITE_ORDER = [
  "mca.google.gmail",
  "mca.google.calendar",
  "mca.google.drive",
  "mca.google.contacts",
  "mca.google.forms",
  "mca.google.analytics",
  "mca.google.docs",
  "mca.google.sheets",
  "mca.google.slides",
] as const

// ── Inline brand logos ──────────────────────────────────────────────────────
// Self-contained data URIs — simplified product marks (page/bars in the
// product's signature colour), not pixel-exact trademark reproductions.
const svgIcon = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`

// A document glyph with a folded corner, tinted to the product colour.
const googlePage = (color: string, fold: string, inner: string) =>
  svgIcon(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="${color}" d="M28 5H14a4 4 0 0 0-4 4v30a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4V15L28 5Z"/><path fill="${fold}" d="M28 5v10h10z"/>${inner}</svg>`,
  )

export const GOOGLE_ICONS: Record<string, string> = {
  "mca.google.docs": googlePage(
    "#4285F4",
    "#A1C2FA",
    '<g fill="#FFFFFF"><rect x="15" y="21" width="18" height="2.6" rx="1.3"/><rect x="15" y="26.5" width="18" height="2.6" rx="1.3"/><rect x="15" y="32" width="12" height="2.6" rx="1.3"/></g>',
  ),
  "mca.google.sheets": googlePage(
    "#0F9D58",
    "#87CEAC",
    '<rect x="15" y="20.5" width="18" height="15" rx="2" fill="#FFFFFF"/><g stroke="#0F9D58" stroke-width="2"><line x1="15" y1="25.5" x2="33" y2="25.5"/><line x1="15" y1="30.5" x2="33" y2="30.5"/><line x1="21" y1="20.5" x2="21" y2="35.5"/><line x1="27" y1="20.5" x2="27" y2="35.5"/></g>',
  ),
  "mca.google.slides": googlePage(
    "#F4B400",
    "#FBE7A1",
    '<rect x="15" y="22" width="18" height="12" rx="2" fill="#FFFFFF"/>',
  ),
  "mca.google.analytics": svgIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="6" width="36" height="36" rx="9" fill="#FFFFFF"/><rect x="13" y="24" width="6" height="12" rx="3" fill="#FBBC04"/><rect x="21" y="18" width="6" height="18" rx="3" fill="#F9AB00"/><rect x="29" y="12" width="6" height="24" rx="3" fill="#E37400"/></svg>',
  ),
}

// ── Full catalog detail for the four apps the backend doesn't have yet ───────

type Tool = { name: string; description: string; group?: string }

/** Shared defaults so each detail below only spells out what's distinctive. */
function googleDetail(
  d: Pick<CatalogMcaDetail, "mcaId" | "name" | "category" | "description"> & {
    keywords: string[]
    accentColors: string[]
    toolsDetailed: Tool[]
  },
): CatalogMcaDetail {
  return {
    mcaId: d.mcaId,
    name: d.name,
    description: d.description,
    tagline: null,
    version: "1.0.0",
    author: { name: "Teros" },
    homepage: null,
    category: d.category,
    icon: GOOGLE_ICONS[d.mcaId] ?? null,
    image: null,
    color: null,
    backgroundImage: null,
    screenshots: [],
    changelog: [],
    keywords: d.keywords,
    verified: true,
    tools: d.toolsDetailed.map((t) => t.name),
    toolsDetailed: d.toolsDetailed,
    accentColors: d.accentColors,
    permissions: [{ type: "network", label: "Network", detail: "Outbound HTTP" }],
    authType: "oauth2",
    availability: { enabled: true, multi: true, system: false, hidden: false, role: "user" },
  }
}

export const GOOGLE_SUITE_DETAILS: Record<string, CatalogMcaDetail> = {
  "mca.google.analytics": googleDetail({
    mcaId: "mca.google.analytics",
    name: "Google Analytics",
    category: "analytics",
    description:
      "Google Analytics 4 (GA4) — run reports, query realtime data, and manage properties and data streams.",
    keywords: ["google", "analytics", "ga4", "reports", "realtime"],
    accentColors: ["#F9AB00", "#E37400", "#FBBC04"],
    toolsDetailed: [
      { name: "-health-check", description: "Check connection and credentials", group: "Status" },
      { name: "analytics-list-accounts", description: "List your Analytics accounts", group: "Accounts" },
      { name: "analytics-list-properties", description: "List properties in an account", group: "Properties" },
      { name: "analytics-get-property", description: "View a property's details", group: "Properties" },
      { name: "analytics-create-property", description: "Create a new property", group: "Properties" },
      { name: "analytics-update-property", description: "Update a property", group: "Properties" },
      { name: "analytics-delete-property", description: "Delete a property", group: "Properties" },
      { name: "analytics-list-data-streams", description: "List data streams for a property", group: "Data streams" },
      { name: "analytics-get-data-stream", description: "View a data stream's details", group: "Data streams" },
      { name: "analytics-create-data-stream", description: "Create a data stream", group: "Data streams" },
      { name: "analytics-run-report", description: "Run a report", group: "Reports" },
      { name: "analytics-batch-run-reports", description: "Run several reports at once", group: "Reports" },
      { name: "analytics-run-realtime-report", description: "Run a realtime report", group: "Reports" },
      { name: "analytics-get-metadata", description: "List available metrics and dimensions", group: "Metadata" },
    ],
  }),
  "mca.google.docs": googleDetail({
    mcaId: "mca.google.docs",
    name: "Google Docs",
    category: "productivity",
    description:
      "Create, read, and edit Google Docs documents — create, read content, insert and append text, find & replace, and batch updates. To delete a document, use the Google Drive Agent App.",
    keywords: ["google", "docs", "documents", "editing"],
    accentColors: ["#4285F4", "#1A73E8", "#A1C2FA"],
    toolsDetailed: [
      { name: "health-check", description: "Check connection and credentials", group: "Status" },
      { name: "create-document", description: "Create a new document", group: "Documents" },
      { name: "read-document", description: "Read a document's content", group: "Documents" },
      { name: "update-document", description: "Apply updates to a document", group: "Documents" },
      { name: "insert-text", description: "Insert text at a position", group: "Editing" },
      { name: "append-text", description: "Append text to the end", group: "Editing" },
      { name: "batch-update-document", description: "Apply a batch of edits", group: "Editing" },
    ],
  }),
  "mca.google.sheets": googleDetail({
    mcaId: "mca.google.sheets",
    name: "Google Sheets",
    category: "productivity",
    description:
      "Create, read, write, append, format, and export Google Sheets spreadsheets — write data, append rows, batch update (formatting, formulas, conditional formatting), read ranges, list tabs, and export to CSV/XLSX/PDF. To delete a spreadsheet, use the Google Drive Agent App.",
    keywords: ["google", "sheets", "spreadsheets", "data", "export"],
    accentColors: ["#0F9D58", "#34A853", "#87CEAC"],
    toolsDetailed: [
      { name: "-health-check", description: "Check connection and credentials", group: "Status" },
      { name: "create-spreadsheet", description: "Create a new spreadsheet", group: "Spreadsheets" },
      { name: "read-spreadsheet", description: "Read a spreadsheet", group: "Reading" },
      { name: "read-sheet-range", description: "Read a range of cells", group: "Reading" },
      { name: "list-sheet-tabs", description: "List the tabs in a spreadsheet", group: "Reading" },
      { name: "write-values", description: "Write values to a range", group: "Writing" },
      { name: "append-values", description: "Append rows of values", group: "Writing" },
      { name: "batch-update", description: "Apply a batch update (formatting, formulas)", group: "Writing" },
      { name: "export-sheet", description: "Export to CSV, XLSX, or PDF", group: "Export" },
    ],
  }),
  "mca.google.slides": googleDetail({
    mcaId: "mca.google.slides",
    name: "Google Slides",
    category: "productivity",
    description:
      "Create, read, update, and delete Google Slides presentations — full read/write support for slides, text, and batch operations.",
    keywords: ["google", "slides", "presentations", "editing"],
    accentColors: ["#F4B400", "#FBBC04", "#FBE7A1"],
    toolsDetailed: [
      { name: "-health-check", description: "Check connection and credentials", group: "Status" },
      { name: "read-presentation", description: "Read a presentation", group: "Reading" },
      { name: "read-slide", description: "Read a single slide", group: "Reading" },
      { name: "create-presentation", description: "Create a new presentation", group: "Presentations" },
      { name: "add-slide", description: "Add a slide", group: "Slides" },
      { name: "update-slide", description: "Update a slide", group: "Slides" },
      { name: "delete-slide", description: "Delete a slide", group: "Slides" },
      { name: "batch-update", description: "Apply a batch of edits", group: "Editing" },
      { name: "replace-text", description: "Find and replace text", group: "Editing" },
    ],
  }),
}

// ── List cards for the four local apps ──────────────────────────────────────
// Derived from the full detail so the catalog list, the detail page and My Apps
// all agree. Re-tagged into the `google` category so they land in the group.
export interface GooglePlaceholderCard {
  mcaId: string
  name: string
  description: string
  icon?: string
  color?: string
  category: string
  tools: string[]
  availability: { enabled: boolean; multi: boolean; system: boolean; hidden: boolean; role: "user" }
}

export const GOOGLE_PLACEHOLDER_CARDS: GooglePlaceholderCard[] = Object.values(
  GOOGLE_SUITE_DETAILS,
).map((d) => ({
  mcaId: d.mcaId,
  name: d.name,
  description: d.description,
  icon: d.icon ?? undefined,
  color: d.color ?? undefined,
  category: "google",
  tools: d.tools,
  availability: { enabled: true, multi: true, system: false, hidden: false, role: "user" },
}))

// ── Simulated installs (prototype) ──────────────────────────────────────────
// These four apps have no backend, so we fake their installed instances: Docs
// with one instance, Sheets and Slides with two each. Analytics stays
// uninstalled for contrast. Injected into both the catalog and My Apps.
export interface FakeInstall {
  appId: string
  mcaId: string
  name: string
}

export const GOOGLE_FAKE_INSTALLS: FakeInstall[] = [
  { appId: "app_gsuite_docs_1", mcaId: "mca.google.docs", name: "Google Docs" },
  { appId: "app_gsuite_sheets_1", mcaId: "mca.google.sheets", name: "Google Sheets" },
  { appId: "app_gsuite_sheets_2", mcaId: "mca.google.sheets", name: "Google Sheets 2" },
  { appId: "app_gsuite_slides_1", mcaId: "mca.google.slides", name: "Google Slides" },
  { appId: "app_gsuite_slides_2", mcaId: "mca.google.slides", name: "Google Slides 2" },
]

// Mock auth so the fake instances render as connected ("Ready") in My Apps
// instead of spinning on "Verifying…" (the backend has no such app).
export const GOOGLE_FAKE_AUTH: Record<string, AppAuthInfo> = Object.fromEntries(
  GOOGLE_FAKE_INSTALLS.map((a) => [a.appId, { status: "ready", authType: "oauth2" } as AppAuthInfo]),
)
