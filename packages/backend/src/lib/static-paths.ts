/**
 * Filesystem locations for served static assets.
 *
 * Single source of truth for where uploaded files (avatars, chat attachments)
 * physically live, shared by the upload handler (writes) and the attachment
 * import handler (reads). Kept dependency-free so it can be imported from any
 * layer without pulling in config/env.
 *
 * @todo alice - 2026.05.20 : replace flat static/ with workspace-scoped storage
 * under /storage/{workspaceId}/files/{fileId} with metadata in MongoDB.
 * See task task_ec0acab4061e90ef on Platform Development board.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = dirname(fileURLToPath(import.meta.url))

/** Static directory where uploaded files are persisted (src/lib → packages/backend/static). */
export const staticDir = join(currentDir, '..', '..', 'static')

/** Subdirectory for generic file uploads (chat attachments, etc.). */
export const uploadDir = join(staticDir, 'uploads')
