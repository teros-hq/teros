/**
 * Platform objects (docs/specs/core/platform-objects.md): objects owned by a
 * workspace or a user, served and transformed by GET /objects/:objectId.
 *
 * Real MongoDB (MONGODB_URI, throwaway db), real files in a temp directory,
 * real images produced with sharp. The route factory is driven with a fake
 * request/response, like agent-apps-storage-routes.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, MongoClient } from "mongodb"
import sharp from "sharp"
import { createAgentAppsStorageRoutes } from "../../src/routes/agent-apps-storage-routes"
import { CallbackHandlers } from "../../src/services/agent-apps/callback-handlers"
import { DeletionService } from "../../src/services/deletion-service"
import {
  deleteAgentAvatarObjects,
  objectVariantsDir,
  putAgentAvatarObject,
} from "../../src/services/platform-objects"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_platform_objects_test_${Date.now()}`
const OBJ_PATH = mkdtempSync(join(tmpdir(), "platform-objects-test-"))
const INSTALL = "app_platobj_1"

let client: MongoClient
let db: Db
let handlers: CallbackHandlers
let routes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
let png: Buffer

async function get(path: string, routeFn = routes) {
  const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) }
  const req = { method: "GET", headers: { host: "localhost" } } as unknown as IncomingMessage
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status
      out.headers = headers
      return this
    },
    end(body?: string | Buffer) {
      out.body = body ? Buffer.from(body) : Buffer.alloc(0)
    },
  } as unknown as ServerResponse
  await routeFn(req, res, path)
  return out
}

const putAvatar = (agentId: string, owner: { workspaceId?: string; userId?: string }) =>
  putAgentAvatarObject(db, OBJ_PATH, { data: png, contentType: "image/png", agentId, owner })

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  handlers = new CallbackHandlers({ db, objectStoragePath: OBJ_PATH })
  routes = createAgentAppsStorageRoutes({ db, callbackHandlers: handlers })
  png = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
  rmSync(OBJ_PATH, { recursive: true, force: true })
})

describe("platform objects · store", () => {
  it("[OBJ-AC-1] a platform object records one owner, its purpose and no installation", async () => {
    const { objectId } = await putAvatar("agent_a1", { workspaceId: "work_1" })
    const doc = await db.collection("agent_app_objects").findOne({ objectId })

    expect(objectId).toMatch(/^obj_[a-f0-9]{16}$/)
    expect(doc).toMatchObject({
      purpose: "agent-avatar",
      agentId: "agent_a1",
      workspaceId: "work_1",
      contentType: "image/png",
      size: png.length,
    })
    expect(doc?.createdAt).toBeInstanceOf(Date)
    expect(doc).not.toHaveProperty("installationId")
    expect(doc).not.toHaveProperty("userId")
    expect((doc?.path as string).startsWith(OBJ_PATH)).toBe(true)
    expect(existsSync(doc?.path as string)).toBe(true)

    const personal = await putAvatar("agent_a2", { userId: "user_1" })
    const personalDoc = await db
      .collection("agent_app_objects")
      .findOne({ objectId: personal.objectId })
    expect(personalDoc).toMatchObject({ userId: "user_1" })
    expect(personalDoc).not.toHaveProperty("workspaceId")
  })

  it("[OBJ-AC-1] both owners, or none, is refused and stores nothing", async () => {
    const before = await db.collection("agent_app_objects").countDocuments()
    await expect(putAvatar("agent_x", { workspaceId: "work_1", userId: "user_1" })).rejects.toThrow(
      "exactly one owner",
    )
    await expect(putAvatar("agent_x", {})).rejects.toThrow("exactly one owner")
    expect(await db.collection("agent_app_objects").countDocuments()).toBe(before)
  })

  it("[OBJ-AC-2] an app installation's get, list and delete do not reach a platform object", async () => {
    const { objectId } = await putAvatar("agent_iso", { workspaceId: "work_1" })
    const own = (await handlers.handle({
      type: "file_object_put",
      installationId: INSTALL,
      data: Buffer.from("app data").toString("base64"),
      contentType: "text/plain",
    } as any)) as any

    const got = (await handlers.handle({
      type: "file_object_get",
      installationId: INSTALL,
      objectId,
    } as any)) as any
    expect(got.data).toBeNull()

    const listed = (await handlers.handle({
      type: "file_object_list",
      installationId: INSTALL,
    } as any)) as any
    expect(listed.objects.map((o: any) => o.objectId)).toEqual([own.objectId])

    await handlers.handle({ type: "file_object_delete", installationId: INSTALL, objectId } as any)
    const doc = await db.collection("agent_app_objects").findOne({ objectId })
    expect(doc).not.toBeNull()
    expect(existsSync(doc?.path as string)).toBe(true)
  })
})

describe("platform objects · GET /objects/:objectId", () => {
  it("[OBJ-AC-3] a platform object is served like an app object", async () => {
    const { objectId } = await putAvatar("agent_get", { workspaceId: "work_1" })
    const appObject = (await handlers.handle({
      type: "file_object_put",
      installationId: INSTALL,
      data: png.toString("base64"),
      contentType: "image/png",
    } as any)) as any

    const platform = await get(`/objects/${objectId}`)
    const app = await get(`/objects/${appObject.objectId}`)

    expect(platform.status).toBe(200)
    expect(platform.body.equals(png)).toBe(true)
    expect(platform.headers).toEqual(app.headers)
    expect(platform.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable")
    expect(platform.headers["X-Content-Type-Options"]).toBe("nosniff")
  })

  it("[OBJ-AC-4] transform parameters return the sized image, stored once and reused", async () => {
    const { objectId } = await putAvatar("agent_tx", { workspaceId: "work_1" })
    const doc = await db.collection("agent_app_objects").findOne({ objectId })
    const url = `/objects/${objectId}?w=112&h=112&fit=cover&format=webp&q=80`

    const first = await get(url)
    expect(first.status).toBe(200)
    expect(first.headers["Content-Type"]).toBe("image/webp")
    expect(first.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable")
    const meta = await sharp(first.body).metadata()
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: "webp",
      width: 112,
      height: 112,
    })

    const variants = objectVariantsDir(doc?.path as string)
    expect(variants.startsWith(OBJ_PATH)).toBe(true)
    expect(readdirSync(variants)).toHaveLength(1)

    // The second request is answered from the stored variant: with the
    // original gone it still succeeds, byte-identical.
    rmSync(doc?.path as string)
    const second = await get(url)
    expect(second.status).toBe(200)
    expect(second.body.equals(first.body)).toBe(true)
    expect(readdirSync(variants)).toHaveLength(1)
  })

  it("[OBJ-AC-5] an invalid parameter, or a transform of a non-image, gets 400", async () => {
    const { objectId } = await putAvatar("agent_bad", { workspaceId: "work_1" })
    for (const query of ["w=0", "w=5000", "w=12abc", "fit=stretch", "format=bmp", "q=0", "q=101"]) {
      const res = await get(`/objects/${objectId}?${query}`)
      expect({ query, status: res.status }).toEqual({ query, status: 400 })
      expect(res.headers["Cache-Control"]).toBe("no-store")
    }

    const pdf = (await handlers.handle({
      type: "file_object_put",
      installationId: INSTALL,
      data: Buffer.from("%PDF-1.7 not an image").toString("base64"),
      contentType: "application/pdf",
    } as any)) as any
    expect((await get(`/objects/${pdf.objectId}?w=56&h=56`)).status).toBe(400)
    // Without transform parameters the original is served, as before.
    expect((await get(`/objects/${pdf.objectId}`)).status).toBe(200)
  })

  it("[OBJ-AC-14] an object stored by one backend is served by one started elsewhere", async () => {
    const { objectId } = await putAvatar("agent_dur", { workspaceId: "work_1" })

    // A second "release": new handlers and routes, same database and storage path.
    const otherRelease = createAgentAppsStorageRoutes({
      db,
      callbackHandlers: new CallbackHandlers({ db, objectStoragePath: OBJ_PATH }),
    })
    const original = await get(`/objects/${objectId}`, otherRelease)
    const variant = await get(`/objects/${objectId}?w=56&h=56&format=webp`, otherRelease)

    expect(original.status).toBe(200)
    expect(original.body.equals(png)).toBe(true)
    expect(variant.status).toBe(200)
    expect((await sharp(variant.body).metadata()).width).toBe(56)
  })
})

describe("platform objects · end of use", () => {
  it("[OBJ-AC-10] deleting an agent deletes all its avatar objects and nobody else's", async () => {
    const first = await putAvatar("agent_del", { workspaceId: "work_1" })
    const second = await putAvatar("agent_del", { workspaceId: "work_1" })
    const other = await putAvatar("agent_keep", { workspaceId: "work_1" })
    await db.collection("agents").insertMany([
      { agentId: "agent_del", workspaceId: "work_1", avatarUrl: second.objectId },
      { agentId: "agent_keep", workspaceId: "work_1", avatarUrl: other.objectId },
    ])

    // Both avatars of the agent are still served after the replacement.
    expect((await get(`/objects/${first.objectId}`)).status).toBe(200)
    expect((await get(`/objects/${second.objectId}?w=40&h=40`)).status).toBe(200)

    const paths = await db
      .collection("agent_app_objects")
      .find({ agentId: "agent_del" })
      .map((d) => d.path as string)
      .toArray()
    expect(paths).toHaveLength(2)

    await new DeletionService(db).deleteAgent("agent_del", "user_1")

    expect(await db.collection("agent_app_objects").countDocuments({ agentId: "agent_del" })).toBe(
      0,
    )
    for (const path of paths) {
      expect(existsSync(path)).toBe(false)
      expect(existsSync(objectVariantsDir(path))).toBe(false)
    }
    expect((await get(`/objects/${first.objectId}`)).status).toBe(404)
    expect((await get(`/objects/${other.objectId}`)).status).toBe(200)
    expect(await deleteAgentAvatarObjects(db, "agent_del")).toBe(0)
  })
})
