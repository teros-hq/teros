import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, buildRecipients } from '../lib'
import type { OutlookSecrets } from '../lib'

export const forwardMessage: ToolConfig = {
  description: 'Forward an email message to other recipients.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to forward' },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      comment: {
        type: 'string',
        description: 'Optional comment to include with the forwarded message',
      },
    },
    required: ['messageId', 'to'],
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

    await graphRequest('POST', `/me/messages/${messageId}/forward`, {
      comment: (args.comment as string) || '',
      toRecipients: buildRecipients(args.to as string),
    })

    return { success: true, account: email, forwardedTo: args.to as string }
  },
}
