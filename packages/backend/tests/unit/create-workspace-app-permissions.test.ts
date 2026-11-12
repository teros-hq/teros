/**
 * Regression test — createWorkspaceApp must seed tool permissions.
 *
 * Bug: `createWorkspaceApp` built the `newApp` object without calling
 * `createInstallPermissions`, so read-only tools defaulted to 'ask'
 * instead of 'allow'. The fix mirrors what `createApp` already does:
 * seed `permissions` from the MCA's tools.json annotations and set
 * `toolExposure` to 'direct' for core platform tools.
 *
 * This test uses a real McaService with a fake MongoDB collection and
 * a fake WorkspaceService to verify the inserted document contains
 * the expected permission seed.
 */

import { describe, expect, it, mock } from "bun:test"
import { McaService } from "../../src/services/mca-service"
import { createInstallPermissions } from "../../src/types/permissions"
import type { App, McpCatalogEntry, Workspace } from "../../src/types/database"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal fake Mongo collection that records insertOne calls. */
function makeFakeCollection() {
  const inserted: any[] = []
  const collection = {
    insertOne: mock(async (doc: any) => {
      inserted.push(doc)
      return { acknowledged: true, insertedId: doc._id ?? "fake-id" }
    }),
    findOne: mock(async () => null), // no existing app → single-install check passes
  }
  return { inserted, collection }
}

/** Fake workspace service — always grants write access, returns a fixed workspace. */
function makeFakeWorkspaceService(workspace: Workspace) {
  return {
    canWrite: mock(async () => true),
    getWorkspace: mock(async () => workspace),
  } as any
}

/** Fake MCA catalog entry for a test MCA. */
function makeFakeMca(mcaId: string, multi = false): McpCatalogEntry {
  return {
    mcaId,
    name: mcaId,
    description: "test mca",
    version: "1.0.0",
    availability: { multi },
    execution: { type: "stdio", command: "node", args: [] },
  } as McpCatalogEntry
}

/** Build a fake Db that routes the `apps` and `mca_catalog` collections. */
function makeFakeDb(mcaId: string) {
  const { inserted, collection } = makeFakeCollection()
  const fakeDb = {
    collection: (name: string) => {
      if (name === "apps") return collection
      if (name === "mca_catalog") return { findOne: mock(async () => makeFakeMca(mcaId)) }
      return { findOne: mock(async () => null) }
    },
  } as any
  return { fakeDb, inserted }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkspaceApp — permission seeding (regression)", () => {
  const WORKSPACE_ID = "work_test"
  const USER_ID = "user_test"
  const VOLUME_ID = "vol_test"

  const workspace: Workspace = {
    workspaceId: WORKSPACE_ID,
    ownerId: USER_ID,
    volumeId: VOLUME_ID,
  } as Workspace

  it("seeds permissions from tools.json — read-only tools get 'allow'", async () => {
    const mcaId = "mca.teros.filesystem"
    const { fakeDb, inserted } = makeFakeDb(mcaId)

    const svc = new McaService(fakeDb, {
      workspaceService: makeFakeWorkspaceService(workspace),
    })

    await svc.createWorkspaceApp(WORKSPACE_ID, mcaId, "test-fs", USER_ID)

    expect(inserted.length).toBe(1)
    const app = inserted[0] as App

    // permissions must be present and seeded
    expect(app.permissions).toBeDefined()
    expect(app.permissions!.defaultPermission).toBe("ask")

    // read-only tools from mca.teros.filesystem tools.json
    // (2026-09-30: updated to current tool names — read-batch/read-media were
    //  renamed to read-file/read-files in the manifest, which broke this test)
    expect(app.permissions!.tools["read-file"]).toBe("allow")
    expect(app.permissions!.tools["list-roots"]).toBe("allow")
    expect(app.permissions!.tools["read-binary"]).toBe("allow")

    // mutation tools should be 'ask'
    expect(app.permissions!.tools["create-file"]).toBe("ask")
    expect(app.permissions!.tools["delete-file"]).toBe("ask")
    expect(app.permissions!.tools["edit-file"]).toBe("ask")
  })

  it("seeds permissions matching createInstallPermissions output", async () => {
    const mcaId = "mca.teros.filesystem"
    const { fakeDb, inserted } = makeFakeDb(mcaId)

    const svc = new McaService(fakeDb, {
      workspaceService: makeFakeWorkspaceService(workspace),
    })

    await svc.createWorkspaceApp(WORKSPACE_ID, mcaId, "test-fs-2", USER_ID)

    const app = inserted[0] as App
    // The seeded permissions should be identical to what createInstallPermissions
    // produces from the same tools.json — this is the core regression assertion.
    const expected = createInstallPermissions(
      (svc as any).loadStaticToolDefs(mcaId),
    )
    expect(app.permissions).toEqual(expected)
  })

  it("sets toolExposure to 'direct' for mca.teros.core", async () => {
    const mcaId = "mca.teros.core"
    const { fakeDb, inserted } = makeFakeDb(mcaId)

    const svc = new McaService(fakeDb, {
      workspaceService: makeFakeWorkspaceService(workspace),
    })

    await svc.createWorkspaceApp(WORKSPACE_ID, mcaId, "test-core", USER_ID)

    const app = inserted[0] as App
    expect(app.toolExposure).toBe("direct")
  })

  it("does not set toolExposure to 'direct' for non-core MCAs", async () => {
    const mcaId = "mca.teros.filesystem"
    const { fakeDb, inserted } = makeFakeDb(mcaId)

    const svc = new McaService(fakeDb, {
      workspaceService: makeFakeWorkspaceService(workspace),
    })

    await svc.createWorkspaceApp(WORKSPACE_ID, mcaId, "test-fs-3", USER_ID)

    const app = inserted[0] as App
    expect(app.toolExposure).toBeUndefined()
  })
})
