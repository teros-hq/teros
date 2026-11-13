import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Db } from "mongodb"
import { config } from "../config"
import { pickDefaultAvatar } from "../lib/default-avatars"
import { staticDir, uploadDir } from "../lib/static-paths"
import { detectAvatarImageType, putAgentAvatarObject } from "../services/platform-objects"
import { toBareAvatarFilename } from "./20260623_001_normalize_avatar_urls.js"
import type { Migration } from "./types.js"

/**
 * Agent avatars uploaded to the static directory become platform objects
 * (docs/specs/core/platform-objects.md, OBJ-REQ-8 and OBJ-REQ-9).
 *
 * Until now an uploaded avatar was a file in `packages/backend/static/`, which
 * is part of the release: with release directories (DEP) every deploy left the
 * uploads of the previous release behind, and pruning a release deleted them.
 *
 * For every agent whose `avatarUrl` names such a file (`<id>-avatar-<8 hex>.<ext>`,
 * bare or as this backend's static URL) the file is looked up in the static
 * directory and in the directory that holds the real `static/uploads` — with
 * release directories, the shared root's static directory, where the uploads
 * made before DEP remain. Found and a real image → an object, and `avatarUrl`
 * becomes its id. Not found, not an image, or a `workspace/…` path the static
 * route never served → one of the default avatars.
 *
 * Reads the legacy files and never deletes, moves or modifies them. Idempotent:
 * afterwards no agent matches.
 */

/**
 * What the upload handler named a file: agent id, `-avatar-`, 8 hex, extension.
 * The id was sanitized only later, so an old name may carry a ':' — anything
 * but a path separator is accepted.
 */
const UPLOADED_AVATAR = /^[^/\\]+-avatar-[0-9a-f]{8}\.[A-Za-z0-9]+$/

/**
 * The uploaded file an avatar value names, or null when it names none.
 * @spec OBJ-REQ-8
 */
export function uploadedAvatarFileName(value: string, staticBaseUrl: string): string | null {
  const bare = toBareAvatarFilename(value, staticBaseUrl)
  return UPLOADED_AVATAR.test(bare) ? bare : null
}

/**
 * The directories an uploaded avatar may be in: the static directory, and the
 * one that holds the real (symlink-resolved) uploads directory when it is a
 * different one.
 * @spec OBJ-REQ-8
 */
export async function legacyAvatarDirs(
  staticDirectory: string,
  uploadsDirectory: string,
): Promise<string[]> {
  const dirs = [resolve(staticDirectory)]
  let realUploads: string
  try {
    realUploads = await fs.realpath(uploadsDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return dirs
    throw error
  }
  const shared = dirname(realUploads)
  let realStatic = dirs[0]
  try {
    realStatic = await fs.realpath(staticDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (shared !== realStatic) dirs.push(shared)
  return dirs
}

export interface AvatarMigrationOptions {
  staticDirs: string[]
  objectStoragePath: string
  staticBaseUrl: string
  /** Tie-break of the default avatar choice (0 ≤ r < 1). */
  random?: () => number
  log?: (line: string) => void
}

export interface AvatarMigrationReport {
  migrated: number
  notFound: number
  rejected: number
  workspacePaths: number
  /** Agents that got a default avatar: id and the value it replaced. */
  defaulted: Array<{ agentId: string; replaced: string }>
  /** Agents with neither a workspace nor an owner user: left as they were. */
  unowned: string[]
}

async function readFirst(dirs: string[], name: string): Promise<Buffer | null> {
  for (const dir of dirs) {
    try {
      return await fs.readFile(join(dir, name))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "EISDIR") throw error
    }
  }
  return null
}

/**
 * @spec OBJ-REQ-8, OBJ-REQ-9
 */
export async function migrateAgentAvatarsToObjects(
  db: Db,
  options: AvatarMigrationOptions,
): Promise<AvatarMigrationReport> {
  const log = options.log ?? ((line: string) => console.log(line))
  const agents = db.collection("agents")
  const report: AvatarMigrationReport = {
    migrated: 0,
    notFound: 0,
    rejected: 0,
    workspacePaths: 0,
    defaulted: [],
    unowned: [],
  }

  const candidates = await agents
    .find({ avatarUrl: { $type: "string" } })
    .project({ agentId: 1, avatarUrl: 1, workspaceId: 1, ownerId: 1 })
    .toArray()

  for (const agent of candidates) {
    const agentId = agent.agentId as string
    const value = agent.avatarUrl as string
    const fileName = uploadedAvatarFileName(value, options.staticBaseUrl)
    const isWorkspacePath = value.startsWith("workspace/")
    if (!fileName && !isWorkspacePath) continue

    const workspaceId = (agent.workspaceId as string | null | undefined) || undefined
    const ownerId = (agent.ownerId as string | null | undefined) || undefined
    if (!workspaceId && !ownerId) {
      report.unowned.push(agentId)
      continue
    }

    if (fileName) {
      const data = await readFirst(options.staticDirs, fileName)
      const contentType = data ? detectAvatarImageType(data) : null
      if (data && contentType) {
        const { objectId } = await putAgentAvatarObject(db, options.objectStoragePath, {
          data,
          contentType,
          agentId,
          owner: workspaceId ? { workspaceId } : { userId: ownerId },
        })
        await agents.updateOne({ _id: agent._id }, { $set: { avatarUrl: objectId } })
        report.migrated++
        continue
      }
      if (data) report.rejected++
      else report.notFound++
    } else {
      report.workspacePaths++
    }

    // No usable file: a default avatar, the least used among the agents this
    // one is seen with (its workspace's, or its owner's global agents).
    const peers = await agents
      .find(
        workspaceId
          ? { workspaceId }
          : { ownerId, $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] },
      )
      .project({ avatarUrl: 1 })
      .toArray()
    const avatar = pickDefaultAvatar(
      peers.map((peer) => peer.avatarUrl as string | undefined),
      options.random,
    )
    await agents.updateOne({ _id: agent._id }, { $set: { avatarUrl: avatar } })
    report.defaulted.push({ agentId, replaced: value })
  }

  log(
    `[Migration] agent_avatars_to_objects: ${report.migrated} migrated to objects, ` +
      `${report.notFound} file(s) not found, ${report.rejected} rejected (not an image), ` +
      `${report.workspacePaths} workspace path(s), ${report.unowned.length} without owner`,
  )
  for (const entry of report.defaulted) {
    log(
      `[Migration] agent_avatars_to_objects: ${entry.agentId} got a default avatar (was "${entry.replaced}")`,
    )
  }
  for (const agentId of report.unowned) {
    log(
      `[Migration] agent_avatars_to_objects: ${agentId} has neither a workspace nor an owner — left as it was`,
    )
  }
  return report
}

const migration: Migration = {
  description:
    "Agent avatars uploaded to the static directory become platform objects; a missing file becomes a default avatar (OBJ-REQ-8)",

  async up(db: Db): Promise<void> {
    await migrateAgentAvatarsToObjects(db, {
      staticDirs: await legacyAvatarDirs(staticDir, uploadDir),
      objectStoragePath: config.agentApps.objectStoragePath,
      staticBaseUrl: config.static.baseUrl,
    })
  },

  // No down(): the legacy files are left where they were, but the references
  // that pointed at a missing file are not kept.
}

export default migration
