import type { McaServer } from '@teros/mca-sdk'

// Browse
import { listItems } from './list-items'
import { getItem } from './get-item'
import { searchItems } from './search-items'

// Content
import { downloadFile } from './download-file'
import { getFileContent } from './get-file-content'
import { convertFile } from './convert-file'
import { uploadFile } from './upload-file'

// Organize
import { createFolder } from './create-folder'
import { copyItem } from './copy-item'
import { moveItem } from './move-item'
import { renameItem } from './rename-item'
import { deleteItem } from './delete-item'

// Sharing
import { createShareLink } from './create-share-link'
import { invitePeople } from './invite-people'
import { listPermissions } from './list-permissions'
import { removePermission } from './remove-permission'

// Discovery
import { listSharedWithMe } from './list-shared-with-me'
import { listRecent } from './list-recent'

// Account
import { getDriveInfo } from './get-drive-info'
import { listVersions } from './list-versions'

// Re-export all tools for testing
export {
  listItems,
  getItem,
  searchItems,
  downloadFile,
  getFileContent,
  convertFile,
  uploadFile,
  createFolder,
  copyItem,
  moveItem,
  renameItem,
  deleteItem,
  createShareLink,
  invitePeople,
  listPermissions,
  removePermission,
  listSharedWithMe,
  listRecent,
  getDriveInfo,
  listVersions,
}

/**
 * Register all OneDrive tools on the MCA server.
 *
 * Tool implementations are ported from agentapps-private/apps/microsoft-onedrive.
 * Each tool follows the Teros MCA pattern: ToolConfig with handler that
 * creates a GraphClient and calls the Graph API.
 */
export function registerTools(server: McaServer): void {
  // Browse
  server.tool('list-items', listItems)
  server.tool('get-item', getItem)
  server.tool('search-items', searchItems)

  // Content
  server.tool('download-file', downloadFile)
  server.tool('get-file-content', getFileContent)
  server.tool('convert-file', convertFile)
  server.tool('upload-file', uploadFile)

  // Organize
  server.tool('create-folder', createFolder)
  server.tool('copy-item', copyItem)
  server.tool('move-item', moveItem)
  server.tool('rename-item', renameItem)
  server.tool('delete-item', deleteItem)

  // Sharing
  server.tool('create-share-link', createShareLink)
  server.tool('invite-people', invitePeople)
  server.tool('list-permissions', listPermissions)
  server.tool('remove-permission', removePermission)

  // Discovery
  server.tool('list-shared-with-me', listSharedWithMe)
  server.tool('list-recent', listRecent)

  // Account
  server.tool('get-drive-info', getDriveInfo)
  server.tool('list-versions', listVersions)
}
