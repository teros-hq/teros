import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const deleteFolder: ToolConfig = {
  description: 'Delete a mail folder and all its contents.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'The ID of the folder to delete' },
    },
    required: ['folderId'],
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

    const folderId = args.folderId as string
    await graphRequest('DELETE', `/me/mailFolders/${folderId}`)

    return { success: true, account: email, folderId }
  },
}
