/**
 * Regression test — MCA updates must seed NEW tools with the install-time
 * criterion, not a blanket 'ask'.
 *
 * Bug (2026-10-30, todo-list incident): `propagateToolsToApps` hardcoded
 * new tools to 'ask', ignoring readOnlyHint/safeWriteHint. Apps installed
 * before an MCA update that added safe tools (set-progress, set-input,
 * toggle-instruction-item — all safeWriteHint) kept them denied for 6 days
 * in headless agents. Decision 2026-10-30 (Pablo): seed the delta exactly
 * like createInstallPermissions would have — read-only/safe-write → 'allow'.
 *
 * Invariants under test:
 *   1. New safe tool (readOnly or safeWrite, not alwaysAsk) → 'allow'
 *   2. New mutation tool → 'ask'
 *   3. New safe tool WITH alwaysAsk → 'ask' (confirmation lock always wins)
 *   4. Existing entries are NEVER overwritten — user intent is sacred,
 *      even when it differs from the seed (safe tool pinned 'ask' stays 'ask')
 *   5. Removed tools are cleaned from the map
 *   6. Private tools never get an entry
 *   7. No annotations passed (legacy caller) → conservative 'ask'
 */

import { describe, expect, it, mock } from "bun:test";
import { McaService } from "../../src/services/mca-service";
import type { App, AppToolPermissions } from "../../src/types/database";
import type { McaToolAnnotations } from "@teros/shared";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeAppsState {
  apps: App[];
  updates: Array<{ appId: string; permissions: AppToolPermissions }>;
}

function makeFakeDb(state: FakeAppsState) {
  const collection = {
    find: mock(() => ({
      toArray: mock(async () => state.apps.filter((a) => a.status !== "disabled")),
    })),
    updateOne: mock(async (filter: { appId: string }, update: any) => {
      const target = state.apps.find((a) => a.appId === filter.appId);
      if (!target) return { acknowledged: false };
      target.permissions = update.$set.permissions;
      target.updatedAt = update.$set.updatedAt;
      state.updates.push({ appId: filter.appId, permissions: update.$set.permissions });
      return { acknowledged: true };
    }),
  };
  return {
    collection: (name: string) => {
      if (name === "apps") return collection;
      return { findOne: mock(async () => null) };
    },
  } as any;
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    appId: "app_test1",
    mcaId: "mca.test",
    ownerId: "work_test",
    ownerType: "workspace",
    name: "test-app",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as App;
}

function ann(hints: Partial<McaToolAnnotations>): McaToolAnnotations {
  return hints as McaToolAnnotations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("propagateToolsToApps — MCA update permission seeding (regression)", () => {
  const SAFE_WRITE = ann({ safeWriteHint: true });
  const READ_ONLY = ann({ readOnlyHint: true });
  const SAFE_LOCKED = ann({ safeWriteHint: true, alwaysAsk: true });
  const READ_LOCKED = ann({ readOnlyHint: true, alwaysAsk: true });

  it("repro: app installed before update — new safeWrite tool gets 'allow'", async () => {
    // App installed 2026-08-01 with two tools, both seeded at install
    const app = makeApp({
      permissions: { tools: { "existing-read": "allow", "existing-write": "ask" }, defaultPermission: "ask" },
    });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    // MCA update adds set-progress (safeWriteHint) — the exact incident tool
    const count = await svc.propagateToolsToApps("mca.test", [
      "existing-read",
      "existing-write",
      "set-progress",
    ], new Map([
      ["existing-read", READ_ONLY],
      ["existing-write", undefined as any],
      ["set-progress", SAFE_WRITE],
    ]));

    expect(count).toBe(1);
    const perms = state.apps[0].permissions!;
    expect(perms.tools["set-progress"]).toBe("allow"); // ← the fix
    expect(perms.tools["existing-read"]).toBe("allow"); // untouched
    expect(perms.tools["existing-write"]).toBe("ask"); // untouched
    expect(perms.defaultPermission).toBe("ask");
  });

  it("new readOnly tool gets 'allow'; new mutation tool stays 'ask'", async () => {
    const app = makeApp({ permissions: { tools: {}, defaultPermission: "ask" } });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    await svc.propagateToolsToApps("mca.test", ["list-things", "delete-thing"], new Map([
      ["list-things", READ_ONLY],
      ["delete-thing", undefined as any],
    ]));

    const perms = state.apps[0].permissions!;
    expect(perms.tools["list-things"]).toBe("allow");
    expect(perms.tools["delete-thing"]).toBe("ask");
  });

  it("alwaysAsk never auto-allows — safe+locked tools seed 'ask'", async () => {
    const app = makeApp({ permissions: { tools: {}, defaultPermission: "ask" } });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    await svc.propagateToolsToApps("mca.test", ["locked-write", "locked-read"], new Map([
      ["locked-write", SAFE_LOCKED],
      ["locked-read", READ_LOCKED],
    ]));

    const perms = state.apps[0].permissions!;
    expect(perms.tools["locked-write"]).toBe("ask");
    expect(perms.tools["locked-read"]).toBe("ask");
  });

  it("user-touched entries are NEVER overwritten — safe tool pinned 'ask' stays 'ask'", async () => {
    // User flipped a safe tool to 'ask' (e.g. telegram send-message) — the
    // update must not "restore" the seed over an explicit pin.
    const app = makeApp({
      permissions: { tools: { "send-message": "ask", "pinned-forbid": "forbid" }, defaultPermission: "ask" },
    });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    // Update adds a new tool AND re-lists the pinned ones — only the new
    // tool gets seeded; pins survive with their exact values.
    await svc.propagateToolsToApps("mca.test", ["send-message", "pinned-forbid", "brand-new"], new Map([
      ["send-message", SAFE_WRITE],
      ["pinned-forbid", READ_ONLY],
      ["brand-new", SAFE_WRITE],
    ]));

    const perms = state.apps[0].permissions!;
    expect(perms.tools["send-message"]).toBe("ask"); // user pin preserved
    expect(perms.tools["pinned-forbid"]).toBe("forbid"); // user pin preserved
    expect(perms.tools["brand-new"]).toBe("allow"); // never-touched → seeded
  });

  it("removed tools are cleaned from the map", async () => {
    const app = makeApp({
      permissions: { tools: { "old-tool": "allow", "staying": "ask" }, defaultPermission: "ask" },
    });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    await svc.propagateToolsToApps("mca.test", ["staying"], new Map([["staying", undefined as any]]));

    const perms = state.apps[0].permissions!;
    expect(perms.tools["old-tool"]).toBeUndefined();
    expect(perms.tools["staying"]).toBe("ask");
  });

  it("private tools never get a map entry", async () => {
    const app = makeApp({ permissions: { tools: {}, defaultPermission: "ask" } });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    await svc.propagateToolsToApps("mca.test", ["-health-check", "public-tool"], new Map([
      ["-health-check", READ_ONLY],
      ["public-tool", READ_ONLY],
    ]));

    const perms = state.apps[0].permissions!;
    expect(perms.tools["-health-check"]).toBeUndefined();
    expect(perms.tools["public-tool"]).toBe("allow");
  });

  it("legacy caller without annotations → conservative 'ask' (back-compat)", async () => {
    const app = makeApp({ permissions: { tools: {}, defaultPermission: "ask" } });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    await svc.propagateToolsToApps("mca.test", ["some-safe-tool"]);

    const perms = state.apps[0].permissions!;
    expect(perms.tools["some-safe-tool"]).toBe("ask");
  });

  it("no change → no write (unchanged apps skipped)", async () => {
    const app = makeApp({
      permissions: { tools: { "stable": "allow" }, defaultPermission: "ask" },
    });
    const state = { apps: [app], updates: [] };
    const svc = new McaService(makeFakeDb(state));

    const count = await svc.propagateToolsToApps("mca.test", ["stable"], new Map([["stable", READ_ONLY]]));

    expect(count).toBe(0);
    expect(state.updates.length).toBe(0);
  });
});
