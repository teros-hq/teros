import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatMessage } from '../lib'
import type { OutlookSecrets } from '../lib'

export const getMessage: ToolConfig = {
  description: 'Get full details of a specific email message by ID, including body and attachments.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to retrieve' },
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
    const message = await graphRequest(
      'GET',
      `/me/messages/${messageId}?$expand=attachments($select=id,name,contentType,size,isInline)`,
    )

    return { account: email, ...formatMessage(message, true) }
  },
}
