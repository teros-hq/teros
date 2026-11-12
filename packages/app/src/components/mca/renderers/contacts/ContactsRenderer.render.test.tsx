/**
 * Render tests — ContactsRenderer dispatch coverage (task: re-map to the
 * 2026-10 tool rename).
 *
 * Two guards:
 * 1. COVERAGE: every tool declared in the contacts tools.json (the source of
 *    truth) must render through a DEDICATED sub-renderer — not the dev-only
 *    FallbackRenderer. This is what lets a future rename break CI instead of
 *    silently regressing 100% of calls to the fallback (the bug this task
 *    fixed: tools renamed to bare names, RENDERERS keyed the old
 *    `contacts-*` names, every call fell through).
 * 2. CONTENT: representative tools render their real output shape (verified
 *    against the MCA source, mcas/mca.google.contacts/src/tools/*.ts).
 *
 * Tool names use the RUNTIME format `contacts_<tool>` — the old test passed
 * `contacts-list-contacts` (no underscore), which matched the stale map keys
 * and masked the bug.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionContext, type ToolCallRendererProps } from "../../types"
import { renderWithTamagui } from "../../../../test/renderWithTamagui"
import ContactsToolCallRenderer, { CONTACTS_RENDERERS } from "../ContactsRenderer"

// PermissionDetail (mounted by withPermissionSupport while pending) fetches
// tool metadata via this hook — mock it like the sibling permission tests do.
const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

const here = dirname(fileURLToPath(import.meta.url))
// packages/app/src/components/mca/renderers/contacts → repo root/mcas
const TOOLS_JSON = resolve(here, "../../../../../../../mcas/mca.google.contacts/tools.json")

interface ToolsFile {
  tools: Array<{ name: string }>
}

function toolNames(file: string): string[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ToolsFile
  return parsed.tools.map((t) => t.name)
}

function renderToolCall(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <PermissionContext.Provider
      value={{ onGrant: vi.fn(), onGrantAlways: vi.fn(), onDeny: vi.fn(), onDenyAlways: vi.fn() }}
    >
      <ContactsToolCallRenderer
        toolCallId="tc-test"
        toolName="contacts_list-contacts"
        status="completed"
        {...props}
      />
    </PermissionContext.Provider>,
  )
}

// Cards render collapsed by default — the header (role=button) toggles the
// body. Body-content assertions must expand first. jsdom: click (not press).
function expandCard() {
  fireEvent.click(screen.getByRole("button"))
}

beforeEach(() => {
  useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// Guard 1 — dispatch coverage vs tools.json (the regression this task fixed)
// ============================================================================

describe("ContactsRenderer — dispatch coverage vs tools.json", () => {
  it("every contacts tool has a dedicated renderer (no fallback)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const names = toolNames(TOOLS_JSON)

    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const { unmount } = renderToolCall({
        toolName: `contacts_${name}`,
        output: JSON.stringify({ contacts: [], groups: [] }),
      })
      expect(
        screen.queryByText("no renderer"),
        `tool "${name}" fell through to FallbackRenderer — add a sub-renderer + CONTACTS_RENDERERS entry`,
      ).toBeNull()
      unmount()
    }
    // Scoped to OUR fallback warn — jsdom also fires RN's unrelated
    // `useNativeDriver` warning (HeaderRow uses Animated.timing).
    const fallbackWarns = warn.mock.calls.filter((call) =>
      String(call[0]).includes("[ContactsRenderer]"),
    )
    expect(fallbackWarns).toEqual([])
  })

  it("every CONTACTS_RENDERERS key exists in tools.json (no stale keys)", () => {
    const names = toolNames(TOOLS_JSON)
    for (const key of Object.keys(CONTACTS_RENDERERS)) {
      expect(
        names.includes(key),
        `CONTACTS_RENDERERS key "${key}" matches no tools.json tool — stale key after a rename?`,
      ).toBe(true)
    }
  })
})

// ============================================================================
// Guard 2 — representative content (real shapes from the MCA source)
// ============================================================================

describe("ContactsRenderer — representative content", () => {
  it("list-contacts renders contacts + count badge", () => {
    renderToolCall({
      toolName: "contacts_list-contacts",
      output: JSON.stringify({
        contacts: [
          { resourceName: "people/c1", name: "Alice Smith" },
          { resourceName: "people/c2", name: "Bob Jones" },
        ],
        totalItems: 2,
      }),
    })

    expandCard()

    expect(screen.getByText("Listed 2 contacts")).toBeTruthy()
    // totalItems set → badge shows "2/2" rather than the bare count
    expect(screen.getByText("2/2")).toBeTruthy()
    expect(screen.getByText("Alice Smith")).toBeTruthy()
    expect(screen.getByText("Bob Jones")).toBeTruthy()
  })

  it("get-contact renders the normalized detail (organizations, not the old nonexistent fields)", () => {
    renderToolCall({
      toolName: "contacts_get-contact",
      input: { resourceName: "people/c1" },
      output: JSON.stringify({
        resourceName: "people/c1",
        name: "Alice Smith",
        organizations: [{ name: "Acme Corp", title: "CEO" }],
        biographies: ["First bio line"],
        addresses: [{ formattedValue: "1600 Amphitheatre Pkwy" }],
        emails: [{ value: "alice@acme.com", type: "work" }],
        phones: [{ value: "+1 555 0100", type: "mobile" }],
      }),
    })

    expandCard()

    // Description uses the display name from the output — it also appears in
    // the body header, so assert on ALL matches rather than a unique one.
    expect(screen.getAllByText("Alice Smith").length).toBeGreaterThan(0)
    expect(screen.getByText("alice@acme.com")).toBeTruthy()
    expect(screen.getByText("Acme Corp")).toBeTruthy()
    expect(screen.getByText("1600 Amphitheatre Pkwy")).toBeTruthy()
  })

  it("search-contacts renders the query in the description", () => {
    renderToolCall({
      toolName: "contacts_search-contacts",
      input: { query: "john" },
      output: JSON.stringify({
        contacts: [{ resourceName: "people/c3", name: "John Doe" }],
      }),
    })

    expandCard()

    expect(screen.getByText('Search "john"')).toBeTruthy()
    expect(screen.getByText("1 result")).toBeTruthy()
    expect(screen.getByText("John Doe")).toBeTruthy()
  })

  it("create-contact renders givenName/familyName inputs and the created contact", () => {
    renderToolCall({
      toolName: "contacts_create-contact",
      input: { givenName: "Jane", familyName: "Doe", email: "jane@example.com" },
      output: JSON.stringify({
        success: true,
        resourceName: "people/c9",
        name: "Jane Doe",
      }),
    })

    expandCard()

    expect(screen.getByText("Created: Jane Doe")).toBeTruthy()
    expect(screen.getByText("created")).toBeTruthy()
    expect(screen.getByText(/created successfully/)).toBeTruthy()
  })

  it("delete-contact renders the irreversible delete outcome", () => {
    renderToolCall({
      toolName: "contacts_delete-contact",
      input: { resourceName: "people/c1" },
      output: JSON.stringify({ success: true, message: "Contact deleted" }),
    })

    expandCard()

    expect(screen.getByText("Contact deleted")).toBeTruthy()
    expect(screen.getByText("deleted")).toBeTruthy()
    expect(screen.getByText(/deleted successfully/)).toBeTruthy()
  })

  it("list-contact-groups renders group rows + count badge", () => {
    renderToolCall({
      toolName: "contacts_list-contact-groups",
      output: JSON.stringify({
        groups: [
          { resourceName: "contactGroups/g1", name: "Family", groupType: "USER_CONTACT_GROUP", memberCount: 3 },
          { resourceName: "contactGroups/g2", name: "Work", groupType: "USER_CONTACT_GROUP", memberCount: 5 },
        ],
        totalItems: 2,
      }),
    })

    expandCard()

    expect(screen.getByText("Listed 2 groups")).toBeTruthy()
    expect(screen.getByText("2 groups")).toBeTruthy()
    expect(screen.getByText("Family")).toBeTruthy()
    expect(screen.getByText("Work")).toBeTruthy()
    // memberCount badges on each row
    expect(screen.getByText("3 members")).toBeTruthy()
    expect(screen.getByText("5 members")).toBeTruthy()
  })

  it("get-contact-group renders the group detail with members", () => {
    renderToolCall({
      toolName: "contacts_get-contact-group",
      input: { resourceName: "contactGroups/g1" },
      output: JSON.stringify({
        resourceName: "contactGroups/g1",
        name: "Family",
        formattedName: "Family",
        groupType: "USER_CONTACT_GROUP",
        memberCount: 2,
        memberResourceNames: ["people/c1", "people/c2"],
      }),
    })

    expandCard()

    // "Family" appears in the description AND the ResourceCard title —
    // assert on all matches.
    expect(screen.getAllByText("Family").length).toBeGreaterThan(0)
    expect(screen.getByText("2 members")).toBeTruthy()
    expect(screen.getByText("people/c1")).toBeTruthy()
    expect(screen.getByText("people/c2")).toBeTruthy()
  })

  it("add-contacts-to-group renders the DualEntity membership action", () => {
    renderToolCall({
      toolName: "contacts_add-contacts-to-group",
      input: {
        resourceName: "contactGroups/g1",
        contactResourceNames: ["people/c1", "people/c2"],
      },
      output: JSON.stringify({
        success: true,
        message: "Added 2 contacts to group",
      }),
    })

    expandCard()

    expect(screen.getByText("Add 2 contact(s) to group")).toBeTruthy()
    // "2 contacts" appears in the badge AND the DualEntity left title.
    expect(screen.getAllByText("2 contacts").length).toBeGreaterThan(0)
    expect(screen.getByText("Added 2 contacts to group")).toBeTruthy()
  })

  it("remove-contacts-from-group renders the DualEntity membership action", () => {
    renderToolCall({
      toolName: "contacts_remove-contacts-from-group",
      input: {
        resourceName: "contactGroups/g1",
        contactResourceNames: ["people/c1"],
      },
      output: JSON.stringify({
        success: true,
        message: "Removed 1 contact from group",
      }),
    })

    expandCard()

    expect(screen.getByText("Remove 1 contact(s) from group")).toBeTruthy()
    expect(screen.getByText("people/c1")).toBeTruthy()
    expect(screen.getByText("Removed 1 contact from group")).toBeTruthy()
  })

  it("delete-contact-group renders the contactsDeleted-aware outcome", () => {
    renderToolCall({
      toolName: "contacts_delete-contact-group",
      input: { resourceName: "contactGroups/g1", deleteContacts: false },
      output: JSON.stringify({
        success: true,
        message: "Group deleted",
        contactsDeleted: false,
      }),
    })

    expandCard()

    expect(screen.getByText("Delete group")).toBeTruthy()
    expect(screen.getByText("Group deleted (contacts kept)")).toBeTruthy()
  })

  it("-health-check renders the ready status", () => {
    renderToolCall({
      toolName: "contacts_-health-check",
      output: JSON.stringify({
        status: "ready",
        version: "1.0.0",
        uptime: 3600,
      }),
    })

    expandCard()

    expect(screen.getByText("Connected to Google Contacts")).toBeTruthy()
    // "ready" appears in the badge AND the KeyValueGrid status row.
    expect(screen.getAllByText("ready").length).toBeGreaterThan(0)
    expect(screen.getByText("OAuth credentials verified")).toBeTruthy()
  })

  it("failed status surfaces the error block", () => {
    renderToolCall({
      toolName: "contacts_list-contacts",
      status: "failed",
      error: "Google API quota exceeded",
    })

    expandCard()

    expect(screen.getByText("Failed to list contacts")).toBeTruthy()
    expect(screen.getByText("Google API quota exceeded")).toBeTruthy()
  })

  it("pending_permission renders the awaiting badge and action copy", () => {
    renderToolCall({
      toolName: "contacts_delete-contact",
      status: "pending_permission",
      permissionRequestId: "pr-test",
      appId: "app-test",
      input: { resourceName: "people/c1" },
    })

    // The card auto-expands while pending (forceExpand) — no expandCard().
    expect(screen.getByText("awaiting")).toBeTruthy()
    expect(screen.getByText("Delete contact")).toBeTruthy()
  })
})
