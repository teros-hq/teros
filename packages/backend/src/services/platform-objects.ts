/**
 * Platform objects — objects the platform itself stores in the object store
 * (docs/specs/core/platform-objects.md).
 *
 * An app installation's objects carry `installationId`. A platform object
 * carries none: it records exactly one owner (`workspaceId` or `userId`) and a
 * `purpose`. It lives under the object storage path, never inside the code
 * tree, so a deploy cannot lose it, and it is served by `GET /objects/:id` like
 * any other object.
 */

import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { Db } from "mongodb"
import { COLLECTIONS, collection } from "../db"

const OBJECT_ID = /^obj_[a-f0-9]{16}$/
const PLATFORM_DIR = "_platform"

/** The image types an agent avatar may be (OBJ-REQ-4). */
export type AvatarImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

/** Exactly one of the two (OBJ-REQ-1). */
export interface PlatformObjectOwner {
  workspaceId?: string
  userId?: string
}

export interface AgentAvatarObjectInput {
  data: Buffer
  contentType: AvatarImageType
  agentId: string
  owner: PlatformObjectOwner
}

/**
 * Is this stored value an object id (as opposed to a file name or a URL)?
 * @spec OBJ-REQ-5
 */
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value)
}

/**
 * The image type of these bytes, read from their signature — never from a file
 * name or a declared MIME type. `null` when they are not JPEG, PNG, GIF or WebP.
 * @spec OBJ-REQ-4
 */
export function detectAvatarImageType(data: Buffer): AvatarImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png"
  }
  if (data.length >= 6) {
    const head = data.subarray(0, 6).toString("latin1")
    if (head === "GIF87a" || head === "GIF89a") return "image/gif"
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp"
  }
  return null
}

/** The owner an agent's avatar gets: its workspace, or its owner user when it has none. */
export function agentAvatarOwner(agent: {
  workspaceId?: string | null
  ownerId?: string | null
}): PlatformObjectOwner {
  if (agent.workspaceId) return { workspaceId: agent.workspaceId }
  if (agent.ownerId) return { userId: agent.ownerId }
  throw new Error("Agent has neither a workspace nor an owner user")
}

function ownerFields(owner: PlatformObjectOwner): { workspaceId: string } | { userId: string } {
  const hasWorkspace = typeof owner.workspaceId === "string" && owner.workspaceId !== ""
  const hasUser = typeof owner.userId === "string" && owner.userId !== ""
  if (hasWorkspace === hasUser) {
    throw new Error("A platform object has exactly one owner: workspaceId or userId")
  }
  return hasWorkspace ? { workspaceId: owner.workspaceId! } : { userId: owner.userId! }
}

/** Where the stored variants of an object live: next to its file. */
export function objectVariantsDir(objectFilePath: string): string {
  return `${objectFilePath}.variants`
}

/**
 * Store an agent avatar as a platform object.
 * @spec OBJ-REQ-1, OBJ-REQ-4
 */
export async function putAgentAvatarObject(
  db: Db,
  objectStoragePath: string,
  input: AgentAvatarObjectInput,
): Promise<{ objectId: string }> {
  const owner = ownerFields(input.owner)
  const ownerId = "workspaceId" in owner ? owner.workspaceId : owner.userId
  const objectId = `obj_${randomBytes(8).toString("hex")}`
  const dir = join(objectStoragePath, PLATFORM_DIR, ownerId.replace(/[^a-zA-Z0-9_-]/g, "_"))
  const path = join(dir, objectId)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, input.data)

  await collection(db, COLLECTIONS.agentAppObjects).insertOne({
    objectId,
    purpose: "agent-avatar",
    agentId: input.agentId,
    ...owner,
    contentType: input.contentType,
    size: input.data.length,
    path,
    createdAt: new Date(),
  })

  return { objectId }
}

/**
 * Delete every avatar object uploaded for an agent: file, stored variants and
 * record. Returns how many objects were deleted.
 * @spec OBJ-REQ-7
 */
export async function deleteAgentAvatarObjects(db: Db, agentId: string): Promise<number> {
  const objects = collection(db, COLLECTIONS.agentAppObjects)
  const docs = await objects.find({ purpose: "agent-avatar", agentId }).toArray()
  for (const doc of docs) {
    const path = doc.path as string
    await fs.rm(path, { force: true })
    await fs.rm(objectVariantsDir(path), { recursive: true, force: true })
    await objects.deleteOne({ objectId: doc.objectId, purpose: "agent-avatar", agentId })
  }
  return docs.length
}
