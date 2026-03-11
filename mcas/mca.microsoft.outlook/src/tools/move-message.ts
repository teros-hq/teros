import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const moveMessage: ToolConfig = {
  description: 'Move a message to a different mail folder.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to move' },
      destinationFolderId: {
        type: 'string',
        description:
          'Destination folder ID or well-known name (e.g., "Inbox", "Archive", "DeletedItems", "JunkEmail")',
      },
    },
    required: ['messageId', 'destinationFolderId'],
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

    const messageId = args.messageId as string
    const destinationId = args.destinationFolderId as string

    const moved = await graphRequest('POST', `/me/messages/${messageId}/move`, {
      destinationId,
    })

    return { success: true, account: email, messageId: moved.id, destinationFolderId: destinationId }
  },
}
