import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const listFolders: ToolConfig = {
  description: 'List all mail folders in the account.',
  parameters: {
    type: 'object',
    properties: {
      includeChildFolders: {
        type: 'boolean',
        description: 'Whether to include child folders (default: false)',
      },
    },
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

    const response = await graphRequest(
      'GET',
      '/me/mailFolders?$select=id,displayName,parentFolderId,totalItemCount,unreadItemCount,isHidden',
    )

    let folders = response.value || []

    if (args.includeChildFolders) {
      const withChildren = await Promise.all(
        folders.map(async (folder: any) => {
          const childResponse = await graphRequest(
            'GET',
            `/me/mailFolders/${folder.id}/childFolders?$select=id,displayName,parentFolderId,totalItemCount,unreadItemCount`,
          )
          return { ...folder, childFolders: childResponse.value || [] }
        }),
      )
      folders = withChildren
    }

    return { account: email, count: folders.length, folders }
  },
}
