/**
 * Agent avatars stored as platform objects (docs/specs/core/platform-objects.md):
 * the upload (OBJ-REQ-4), the resolution and the value stored on an agent
 * update (OBJ-REQ-5).
 *
 * Real MongoDB (MONGODB_URI, throwaway db) and a temp object storage path. The
 * upload goes through HttpUploadHandler.handleRoute with a real multipart body.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, MongoClient } from "mongodb"
import sharp from "sharp"
import { config } from "../../src/config"
import { createUpdateAgentHandler } from "../../src/handlers/domains/agent/update"
import { HttpUploadHandler } from "../../src/handlers/http-upload-handler"
import { buildAvatarUrl, toStoredAvatarValue } from "../../src/lib/avatar-url"
import { staticDir } from "../../src/lib/static-paths"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_agent_avatar_objects_test_${Date.now()}`
const OBJ_PATH = mkdtempSync(join(tmpdir(), "agent-avatar-objects-test-"))
const OBJECTS_BASE = `${config.agentApps.publicUrl.replace(/\/$/, "")}/objects/`

const OWNER = "user_owner"
const WS = "work_avatars"

let client: MongoClient
let db: Db
let handler: HttpUploadHandler
let png: Buffer

const authService = {
  validateSession: async () => ({ success: true, user: { userId: OWNER } }),
} as any

function multipart(file: Buffer, filename: string, contentType: string) {
  const boundary = "avatarboundary"
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    resume() {},
    async *[Symbol.asyncIterator]() {
      yield body
    },
  } as any
}

async function upload(agentId: string, file: Buffer, filename = "me.png", type = "image/png") {
  const captured = { status: 0, body: {} as any }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(body?: string) {
      if (body) captured.body = JSON.parse(body)
    },
  } as any
  await handler.handleRoute(multipart(file, filename, type), res, `/api/upload/avatar/${agentId}`)
  return captured
}

const staticFiles = () => readdirSync(staticDir).sort()

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  handler = new HttpUploadHandler(db, authService, null, OBJ_PATH)
  png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer()
  await db.collection("workspaces").insertOne({ workspaceId: WS, ownerId: OWNER, status: "active" })
  await db.collection("agents").insertMany([
    { agentId: "agent_ws", coreId: "core_x", name: "Ws", ownerId: OWNER, workspaceId: WS },
    { agentId: "agent_global", coreId: "core_x", name: "Global", ownerId: OWNER },
    { agentId: "agent_bad", coreId: "core_x", name: "Bad", ownerId: OWNER },
  ])
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
  rmSync(OBJ_PATH, { recursive: true, force: true })
})

describe("agent avatar upload → platform object", () => {
  it("[OBJ-AC-6] a workspace agent's avatar is an object owned by the workspace", async () => {
    const before = staticFiles()
    const res = await upload("agent_ws", png)

    expect(res.status).toBe(200)
    const agent = await db.collection("agents").findOne({ agentId: "agent_ws" })
    expect(agent?.avatarUrl).toMatch(/^obj_[a-f0-9]{16}$/)
    expect(res.body).toEqual({
      success: true,
      filename: agent?.avatarUrl,
      url: `${OBJECTS_BASE}${agent?.avatarUrl}`,
    })

    const object = await db.collection("agent_app_objects").findOne({ objectId: agent?.avatarUrl })
    expect(object).toMatchObject({
      purpose: "agent-avatar",
      agentId: "agent_ws",
      workspaceId: WS,
      contentType: "image/png",
    })
    expect(object).not.toHaveProperty("userId")
    expect((object?.path as string).startsWith(OBJ_PATH)).toBe(true)
    expect(existsSync(object?.path as string)).toBe(true)

    // Nothing was written into the static directory.
    expect(staticFiles()).toEqual(before)
  })

  it("[OBJ-AC-6] a global agent's avatar is owned by its owner user", async () => {
    const res = await upload("agent_global", png)
    expect(res.status).toBe(200)
    const agent = await db.collection("agents").findOne({ agentId: "agent_global" })
    const object = await db.collection("agent_app_objects").findOne({ objectId: agent?.avatarUrl })
    expect(object).toMatchObject({
      purpose: "agent-avatar",
      agentId: "agent_global",
      userId: OWNER,
    })
    expect(object).not.toHaveProperty("workspaceId")
  })

  it("[OBJ-AC-6] the content type comes from the bytes, not from the name or declared type", async () => {
    const webp = await sharp(png).webp().toBuffer()
    const res = await upload("agent_global", webp, "photo.png", "image/png")
    expect(res.status).toBe(200)
    const agent = await db.collection("agents").findOne({ agentId: "agent_global" })
    const object = await db.collection("agent_app_objects").findOne({ objectId: agent?.avatarUrl })
    expect(object?.contentType).toBe("image/webp")
  })

  it("[OBJ-AC-7] bytes that are not an image are rejected and nothing is stored", async () => {
    const objectsBefore = await db.collection("agent_app_objects").countDocuments()
    const html = Buffer.from("<!doctype html><script>alert(1)</script>")
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )

    for (const bytes of [html, svg]) {
      const res = await upload("agent_bad", bytes, "a.png", "image/png")
      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    }

    expect(await db.collection("agent_app_objects").countDocuments()).toBe(objectsBefore)
    const agent = await db.collection("agents").findOne({ agentId: "agent_bad" })
    expect(agent).not.toHaveProperty("avatarUrl")
  })
})

describe("agent avatar · object reference", () => {
  it("[OBJ-AC-8] an object id resolves to the object URL", () => {
    expect(buildAvatarUrl("obj_0123456789abcdef")).toBe(`${OBJECTS_BASE}obj_0123456789abcdef`)
    // A shipped file and an external URL resolve as before.
    expect(buildAvatarUrl("iria.png")).toBe(`${config.static.baseUrl}/iria.png`)
    expect(buildAvatarUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png")
  })

  it("[OBJ-AC-8] this backend's object URL is stored as the object id", () => {
    const id = "obj_0123456789abcdef"
    expect(toStoredAvatarValue(`${OBJECTS_BASE}${id}`)).toBe(id)
    expect(toStoredAvatarValue(`${OBJECTS_BASE}${id}?w=56&h=56&fit=cover&format=webp&q=80`)).toBe(
      id,
    )
    // Anything else is stored as received.
    expect(toStoredAvatarValue("https://other.example.com/objects/obj_0123456789abcdef")).toBe(
      "https://other.example.com/objects/obj_0123456789abcdef",
    )
    expect(toStoredAvatarValue("avatars/default-03.jpg")).toBe("avatars/default-03.jpg")
  })

  it("[OBJ-AC-8] an agent update carrying the object URL stores the id and lists the URL", async () => {
    await upload("agent_global", png)
    const stored = (await db.collection("agents").findOne({ agentId: "agent_global" }))?.avatarUrl
    const update = createUpdateAgentHandler(db, null)

    const result = await update(
      { userId: OWNER, sessionId: "s1" } as any,
      {
        agentId: "agent_global",
        intro: "edited",
        avatarUrl: `${OBJECTS_BASE}${stored}?w=56&h=56&fit=cover&format=webp&q=80`,
      } as any,
    )

    const agent = await db.collection("agents").findOne({ agentId: "agent_global" })
    expect(agent?.avatarUrl).toBe(stored)
    expect((result as any).agent.avatarUrl).toBe(`${OBJECTS_BASE}${stored}`)
  })
})
