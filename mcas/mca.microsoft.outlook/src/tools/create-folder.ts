import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const createFolder: ToolConfig = {
  description: 'Create a new mail folder.',
  parameters: {
    type: 'object',
    properties: {
      displayName: { type: 'string', description: 'Name for the new folder' },
      parentFolderId: {
        type: 'string',
        description: 'Parent folder ID (optional, creates at top level if omitted)',
      },
    },
    required: ['displayName'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as OutlookSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
    )

    const displayName = args.displayName as string
    const parentFolderId = args.parentFolderId as string | undefined

    const path = parentFolderId
      ? `/me/mailFolders/${parentFolderId}/childFolders`
      : '/me/mailFolders'

    const folder = await graphRequest('POST', path, { displayName })

    return { success: true, account: email, folderId: folder.id, displayName: folder.displayName }
  },
}
