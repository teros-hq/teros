/**
 * WS transport preserves the backend error `code` end-to-end (TER-546 / #238).
 *
 * Bug: ws-transport rejected with a bare Error whose `.code` was undefined, so
 * the three admin windows (FeatureFlags / Users / AgentUsage) could not branch on
 * the contract and showed the raw English backend message instead of a localized
 * 'admin privileges required'. Fix (ws-transport.routeMessage): copy the backend
 * `code` onto the rejected Error.
 *
 * This is the keystone the whole authz suite relies on (attemptAction reads
 * `err.code`). Here we pin it for the exact actions #238 names: a non-admin user
 * hitting each admin window's WS action must reject with `code === 'FORBIDDEN'`,
 * not a code-less error.
 *
 * Mutation check: drop `if (code) err.code = code` in ws-transport.ts (Metro
 * re-bundles) → `code` arrives null on the client → these assertions go red.
 */
import { expect, test } from "../fixtures"
import { attemptAction } from "../helpers/teros"

// The 3 admin-window read actions (all gated requireSystemAdmin → FORBIDDEN).
const ADMIN_ACTIONS: Array<{ action: string; params: Record<string, unknown> }> = [
  { action: "featureFlags.list", params: {} },
  { action: "admin.list-users", params: {} },
  { action: "admin-api.usage-summary", params: {} },
]

test.describe("transporte — error.code preservado en gates admin @security", () => {
  for (const { action, params } of ADMIN_ACTIONS) {
    test(`${action}: un no-admin recibe code=FORBIDDEN (no error sin code)`, async ({
      terosPage,
    }) => {
      const r = await attemptAction(terosPage, action, params)
      expect(r.resolved, `${action}: un no-admin no debe pasar el gate`).toBe(false)
      // The load-bearing fact (#238): the structured code survives the transport.
      expect(r.code, `${action}: el code del backend llega al cliente`).toBe("FORBIDDEN")
      // And the message is the admin string (so i18n can map it by code).
      expect(r.message ?? "", `${action}: message`).toMatch(/Admin (privileges|access) required/)
    })
  }
})
