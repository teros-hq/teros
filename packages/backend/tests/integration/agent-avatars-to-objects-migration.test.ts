/**
 * Migration 20261113_001 — agent avatars uploaded to the static directory
 * become platform objects (docs/specs/core/platform-objects.md, OBJ-REQ-8/9).
 *
 * Real MongoDB (MONGODB_URI, throwaway db per test) and a temp directory tree
 * that reproduces both layouts: a plain checkout (uploads inside the static
 * directory) and a release directory (static/uploads is a symlink into the
 * shared root, where the old uploads remain).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, MongoClient } from "mongodb"
import sharp from "sharp"
import {
  legacyAvatarDirs,
  migrateAgentAvatarsToObjects,
  uploadedAvatarFileName,
} from "../../src/migrations/20261113_001_agent_avatars_to_objects"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const STATIC_BASE = "https://be.example.com/static"
const WS = "work_mig"

let client: MongoClient
let db: Db
let root: string
let staticDir: string
let objects: string
let png: Buffer
let webp: Buffer
let n = 0

const run = (dirs: string[], log: string[] = []) =>
  migrateAgentAvatarsToObjects(db, {
    staticDirs: dirs,
    objectStoragePath: objects,
    staticBaseUrl: STATIC_BASE,
    random: () => 0,
    log: (line) => log.push(line),
  })

const agent = (agentId: string) => db.collection("agents").findOne({ agentId })
const object = (objectId: unknown) => db.collection("agent_app_objects").findOne({ objectId })

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#336699" } })
    .png()
    .toBuffer()
  webp = await sharp(png).webp().toBuffer()
})

beforeEach(() => {
  db = client.db(`teros_avatar_migration_test_${Date.now()}_${n++}`)
  root = mkdtempSync(join(tmpdir(), "avatar-migration-test-"))
  staticDir = join(root, "static")
  objects = join(root, "objects")
  mkdirSync(join(staticDir, "uploads"), { recursive: true })
})

afterEach(async () => {
  await db.dropDatabase()
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await client.close()
})

describe("migration · agent avatars to objects", () => {
  it("[OBJ-AC-11] recognises an uploaded file by its name, bare or as this backend's static URL", () => {
    expect(uploadedAvatarFileName("agent_one-avatar-1a2b3c4d.png", STATIC_BASE)).toBe(
      "agent_one-avatar-1a2b3c4d.png",
    )
    expect(
      uploadedAvatarFileName(`${STATIC_BASE}/agent_one-avatar-1a2b3c4d.png`, STATIC_BASE),
    ).toBe("agent_one-avatar-1a2b3c4d.png")
    // Names from before the agent id was sanitized carry a ':'.
    expect(uploadedAvatarFileName("agent:iria-avatar-2a26a40a.png", STATIC_BASE)).toBe(
      "agent:iria-avatar-2a26a40a.png",
    )
    // Shipped files, other hosts, paths and object ids name no uploaded file.
    for (const value of [
      "iria.png",
      "alice-avatar.jpg",
      "avatars/default-01.jpg",
      "https://cdn.example.com/static/agent_one-avatar-1a2b3c4d.png",
      "uploads/agent_one-avatar-1a2b3c4d.png",
      "obj_0123456789abcdef",
    ]) {
      expect({ value, file: uploadedAvatarFileName(value, STATIC_BASE) }).toEqual({
        value,
        file: null,
      })
    }
  })

  it("[OBJ-AC-11] a bare name and a static URL become objects; legacy files untouched; idempotent", async () => {
    writeFileSync(join(staticDir, "agent_one-avatar-1a2b3c4d.png"), png)
    writeFileSync(join(staticDir, "agent_two-avatar-0f0f0f0f.png"), png)
    await db.collection("agents").insertMany([
      {
        agentId: "agent_one",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "agent_one-avatar-1a2b3c4d.png",
      },
      {
        agentId: "agent_two",
        ownerId: "user_2",
        avatarUrl: `${STATIC_BASE}/agent_two-avatar-0f0f0f0f.png`,
      },
    ])

    const report = await run(await legacyAvatarDirs(staticDir, join(staticDir, "uploads")))

    expect(report).toMatchObject({ migrated: 2, notFound: 0, rejected: 0, defaulted: [] })
    const one = await agent("agent_one")
    const two = await agent("agent_two")
    expect(one?.avatarUrl).toMatch(/^obj_[a-f0-9]{16}$/)
    expect(two?.avatarUrl).toMatch(/^obj_[a-f0-9]{16}$/)

    const oneObject = await object(one?.avatarUrl)
    expect(oneObject).toMatchObject({
      purpose: "agent-avatar",
      agentId: "agent_one",
      workspaceId: WS,
      contentType: "image/png",
    })
    expect(oneObject).not.toHaveProperty("userId")
    expect(readFileSync(oneObject?.path as string).equals(png)).toBe(true)

    const twoObject = await object(two?.avatarUrl)
    expect(twoObject).toMatchObject({
      purpose: "agent-avatar",
      agentId: "agent_two",
      userId: "user_2",
    })
    expect(twoObject).not.toHaveProperty("workspaceId")

    // The legacy files are byte-identical.
    expect(readFileSync(join(staticDir, "agent_one-avatar-1a2b3c4d.png")).equals(png)).toBe(true)
    expect(readFileSync(join(staticDir, "agent_two-avatar-0f0f0f0f.png")).equals(png)).toBe(true)

    // A second run changes nothing.
    const again = await run(await legacyAvatarDirs(staticDir, join(staticDir, "uploads")))
    expect(again).toMatchObject({ migrated: 0, notFound: 0, rejected: 0, defaulted: [] })
    expect((await agent("agent_one"))?.avatarUrl).toBe(one?.avatarUrl)
    expect(await db.collection("agent_app_objects").countDocuments()).toBe(2)
  })

  it("[OBJ-AC-12] with release directories the file is found in the shared root", async () => {
    // Shared root: holds the real uploads directory and the old avatar.
    const sharedStatic = join(root, "shared", "packages", "backend", "static")
    mkdirSync(join(sharedStatic, "uploads"), { recursive: true })
    writeFileSync(join(sharedStatic, "agent_old-avatar-deadbeef.jpeg"), png)
    // Release: its own static directory, with uploads symlinked to the shared root.
    const releaseStatic = join(root, "releases", "abc123", "packages", "backend", "static")
    mkdirSync(releaseStatic, { recursive: true })
    symlinkSync(join(sharedStatic, "uploads"), join(releaseStatic, "uploads"))
    await db.collection("agents").insertOne({
      agentId: "agent_old",
      ownerId: "user_1",
      workspaceId: WS,
      avatarUrl: "agent_old-avatar-deadbeef.jpeg",
    })

    const dirs = await legacyAvatarDirs(releaseStatic, join(releaseStatic, "uploads"))
    expect(dirs).toHaveLength(2)
    const report = await run(dirs)

    expect(report.migrated).toBe(1)
    const migrated = await agent("agent_old")
    expect(migrated?.avatarUrl).toMatch(/^obj_[a-f0-9]{16}$/)
    expect((await object(migrated?.avatarUrl))?.contentType).toBe("image/png")
  })

  it("[OBJ-AC-12] in a plain checkout only the static directory is searched", async () => {
    expect(await legacyAvatarDirs(staticDir, join(staticDir, "uploads"))).toHaveLength(1)
    // No uploads directory at all (a fresh install): still the static directory.
    rmSync(join(staticDir, "uploads"), { recursive: true })
    expect(await legacyAvatarDirs(staticDir, join(staticDir, "uploads"))).toHaveLength(1)
  })

  it("[OBJ-AC-13] content type from the bytes; a missing file, a non-image and a workspace path get a default avatar", async () => {
    writeFileSync(join(staticDir, "agent_webp-avatar-11111111.png"), webp)
    writeFileSync(
      join(staticDir, "agent_pdf-avatar-22222222.png"),
      Buffer.from("%PDF-1.7 not an image"),
    )
    await db.collection("agents").insertMany([
      {
        agentId: "agent_webp",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "agent_webp-avatar-11111111.png",
      },
      {
        agentId: "agent_gone",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "agent_gone-avatar-33333333.png",
      },
      {
        agentId: "agent_pdf",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "agent_pdf-avatar-22222222.png",
      },
      {
        agentId: "agent_path",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "workspace/avatars/x.webp",
      },
      // Already using two of the defaults: the migration must pick others.
      {
        agentId: "agent_d1",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "avatars/default-01.jpg",
      },
      {
        agentId: "agent_d2",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "avatars/default-02.jpg",
      },
      // Untouched: a shipped file, an external URL, an agent of another workspace.
      { agentId: "agent_shipped", ownerId: "user_1", workspaceId: WS, avatarUrl: "iria.png" },
      {
        agentId: "agent_ext",
        ownerId: "user_1",
        workspaceId: WS,
        avatarUrl: "https://cdn.example.com/static/a.png",
      },
      {
        agentId: "agent_other",
        ownerId: "user_9",
        workspaceId: "work_other",
        avatarUrl: "avatars/default-03.jpg",
      },
    ])
    const log: string[] = []

    const report = await run([staticDir], log)

    expect(report).toMatchObject({ migrated: 1, notFound: 1, rejected: 1, workspacePaths: 1 })
    expect((await object((await agent("agent_webp"))?.avatarUrl))?.contentType).toBe("image/webp")

    // Least used among the workspace's agents, ties broken by random() = 0:
    // 01 and 02 are taken, so 03, then 04, then 05.
    expect((await agent("agent_gone"))?.avatarUrl).toBe("avatars/default-03.jpg")
    expect((await agent("agent_pdf"))?.avatarUrl).toBe("avatars/default-04.jpg")
    expect((await agent("agent_path"))?.avatarUrl).toBe("avatars/default-05.jpg")
    expect(report.defaulted).toEqual([
      { agentId: "agent_gone", replaced: "agent_gone-avatar-33333333.png" },
      { agentId: "agent_pdf", replaced: "agent_pdf-avatar-22222222.png" },
      { agentId: "agent_path", replaced: "workspace/avatars/x.webp" },
    ])

    expect((await agent("agent_shipped"))?.avatarUrl).toBe("iria.png")
    expect((await agent("agent_ext"))?.avatarUrl).toBe("https://cdn.example.com/static/a.png")
    expect((await agent("agent_other"))?.avatarUrl).toBe("avatars/default-03.jpg")

    // The log carries the counts and, per defaulted agent, its id and the replaced value.
    expect(log[0]).toContain("1 migrated to objects, 1 file(s) not found, 1 rejected")
    for (const entry of report.defaulted) {
      expect(
        log.some((line) => line.includes(entry.agentId) && line.includes(entry.replaced)),
      ).toBe(true)
    }
    // The rejected file is still on disk, untouched.
    expect(readFileSync(join(staticDir, "agent_pdf-avatar-22222222.png")).toString()).toBe(
      "%PDF-1.7 not an image",
    )
  })
})
