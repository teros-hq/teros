import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, processEmailBody } from '../lib'
import type { OutlookSecrets } from '../lib'

export const replyMessage: ToolConfig = {
  description: 'Reply to an existing email message.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to reply to' },
      body: { type: 'string', description: 'Reply body' },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
      replyAll: {
        type: 'boolean',
        description: 'Whether to reply to all recipients (default: false)',
      },
    },
    required: ['messageId', 'body'],
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
    const replyAll = (args.replyAll as boolean) || false

    const { body: processedBody, isHtml } = await processEmailBody(
      args.body as string,
      args.isHtml as boolean | undefined,
    )

    const endpoint = replyAll
      ? `/me/messages/${messageId}/replyAll`
      : `/me/messages/${messageId}/reply`

    await graphRequest('POST', endpoint, { comment: processedBody })

    return {
      success: true,
      account: email,
      replyAll,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    }
  },
}
