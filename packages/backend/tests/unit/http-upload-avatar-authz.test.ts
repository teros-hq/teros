/**
 * TER-733 — the REST avatar-upload endpoint must enforce ownership/tenant.
 *
 * `POST /api/upload/avatar/:agentId` previously updated the agent doc filtered
 * only by `{ agentId }`, so any authenticated user who knew an agentId could
 * overwrite the avatar of an agent they don't own (and, since TER-644, push an
 * `agent.updated` broadcast into a workspace they may not belong to).
 *
 * These tests drive the fix through the PUBLIC handler surface
 * (`HttpUploadHandler.handleRoute`) — no internal exports needed. The denied
 * case is MORDER-style: the scoped update must NOT run for a non-owner.
 *
 * No real MongoDB — the Db + AuthService are mocked. The success path writes a
 * real avatar file to `staticDir`; `afterEach` unlinks anything created.
 */

import { afterAll, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import type { IncomingMessage, ServerResponse } from "http"
import { tmpdir } from "os"
import { join } from "path"
import { HttpUploadHandler } from "../../src/handlers/http-upload-handler"

const USER_PLAIN = "user_plain"
const USER_OTHER = "user_other"
const USER_MEMBER = "user_member" // member of WS_ID, not the owner of AGENT_WS
const AGENT_OWNED = "agent_owned" // global agent owned by USER_PLAIN
const AGENT_FOREIGN = "agent_foreign" // global agent owned by USER_OTHER
const AGENT_WS = "agent_ws" // workspace agent (WS_ID), ownerId USER_OTHER
const WS_ID = "ws_1"

// Agents fixture consulted by the mocked collection.
const AGENTS: Record<string, { ownerId: string; workspaceId?: string }> = {
  [AGENT_OWNED]: { ownerId: USER_PLAIN },
  [AGENT_FOREIGN]: { ownerId: USER_OTHER },
  [AGENT_WS]: { ownerId: USER_OTHER, workspaceId: WS_ID },
}

// Active workspaces + memberships backing canAccessWorkspace (workspace-access.ts).
const WORKSPACES: Record<string, { status: string }> = {
  [WS_ID]: { status: "active" },
}
// (workspaceId, userId) pairs that are members.
const MEMBERS = new Set([`${WS_ID}:${USER_MEMBER}`])

/** Object storage for the uploads of these tests, removed afterwards. */
const OBJECTS_DIR = mkdtempSync(join(tmpdir(), "upload-avatar-authz-test-"))

afterAll(() => {
  rmSync(OBJECTS_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeDb() {
  const updateOne = mock(async (filter: any) => {
    const a = AGENTS[filter.agentId]
    if (!a) return { matchedCount: 0 }
    if (filter.ownerId !== undefined && filter.ownerId !== a.ownerId) return { matchedCount: 0 }
    return { matchedCount: 1 }
  })
  const findOne = mock(async (filter: any) => {
    const a = AGENTS[filter.agentId]
    if (!a) return null
    if (filter.ownerId !== undefined && filter.ownerId !== a.ownerId) return null
    return { agentId: filter.agentId, ...a }
  })
  const agents = { findOne, updateOne }

  // Back canAccessWorkspace (workspace-access.ts:26-36).
  const workspaces = {
    findOne: mock(async (filter: any) => {
      const w = WORKSPACES[filter.workspaceId]
      if (!w) return null
      if (filter.status !== undefined && filter.status !== w.status) return null
      return { workspaceId: filter.workspaceId, ...w }
    }),
  }
  const workspaceMembers = {
    findOne: mock(async (filter: any) =>
      MEMBERS.has(`${filter.workspaceId}:${filter.userId}`)
        ? { workspaceId: filter.workspaceId, userId: filter.userId }
        : null,
    ),
  }

  const db = {
    collection: mock((name: string) => {
      if (name === "agents") return agents
      if (name === "workspaces") return workspaces
      if (name === "workspace_members") return workspaceMembers
      // agent_app_objects: the avatar is stored as a platform object (OBJ-REQ-4).
      return { findOne: mock(async () => null), insertOne: mock(async () => ({ acknowledged: true })) }
    }),
  }
  return { db: db as any, agents }
}

function makeAuthService() {
  // Token IS the userId in these tests — keeps the wiring trivial.
  return {
    validateSession: mock(async (token: string) => ({ success: true, user: { userId: token } })),
  } as any
}

/** Build a mock multipart/form-data request carrying a single file part. */
function makeReq(userId: string): IncomingMessage {
  const boundary = "----teros-test-boundary"
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="avatar.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  )
  // A real PNG signature: the image type is read from the bytes (OBJ-REQ-4).
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const full = Buffer.concat([head, body, tail])

  return {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${userId}`,
    },
    resume() {},
    async *[Symbol.asyncIterator]() {
      yield full
    },
  } as unknown as IncomingMessage
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      res.statusCode = status
      return res
    },
    end(chunk?: string) {
      res.body = chunk ?? ""
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

async function upload(userId: string, agentId: string) {
  const { db, agents } = makeDb()
  const handler = new HttpUploadHandler(db, makeAuthService(), null, OBJECTS_DIR)
  const req = makeReq(userId)
  const res = makeRes()
  await handler.handleRoute(req, res, `/api/upload/avatar/${agentId}`)
  const json = res.body ? JSON.parse(res.body) : {}
  return { res, agents, json }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/upload/avatar/:agentId · access gate (TER-733)", () => {
  it("rejects a user who can't access a global agent and never runs the update", async () => {
    const { res, agents } = await upload(USER_PLAIN, AGENT_FOREIGN)

    expect(res.statusCode).toBe(403)
    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("lets the owner upload a global agent and scopes the update to { agentId }", async () => {
    const { res, agents } = await upload(USER_PLAIN, AGENT_OWNED)

    expect(res.statusCode).toBe(200)
    expect(agents.updateOne).toHaveBeenCalled()
    const filter = (agents.updateOne as any).mock.calls[0][0]
    expect(filter).toMatchObject({ agentId: AGENT_OWNED })
    // Must NOT owner-scope the persist — that would 404 workspace collaborators.
    expect(filter.ownerId).toBeUndefined()
  })

  it("lets a workspace collaborator (non-owner member) upload a workspace agent", async () => {
    const { res, agents } = await upload(USER_MEMBER, AGENT_WS)

    expect(res.statusCode).toBe(200)
    expect(agents.updateOne).toHaveBeenCalled()
    const filter = (agents.updateOne as any).mock.calls[0][0]
    expect(filter).toMatchObject({ agentId: AGENT_WS })
  })

  it("rejects a non-member from uploading a workspace agent", async () => {
    const { res, agents } = await upload(USER_PLAIN, AGENT_WS)

    expect(res.statusCode).toBe(403)
    expect(agents.updateOne).not.toHaveBeenCalled()
  })
})
