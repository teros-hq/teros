import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const deleteMessage: ToolConfig = {
  description:
    'Delete a message (moves to Deleted Items) or permanently delete it.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to delete' },
      permanent: {
        type: 'boolean',
        description:
          'If true, permanently deletes the message. Otherwise moves to Deleted Items (default: false)',
      },
    },
    required: ['messageId'],
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
    const permanent = (args.permanent as boolean) || false

    if (permanent) {
      await graphRequest('DELETE', `/me/messages/${messageId}`)
    } else {
      await graphRequest('POST', `/me/messages/${messageId}/move`, {
        destinationId: 'deleteditems',
      })
    }

    return { success: true, account: email, messageId, permanent }
  },
}
