import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatMessage } from '../lib'
import type { OutlookSecrets } from '../lib'

export const searchMessages: ToolConfig = {
  description: 'Search for email messages. Supports searching by subject, body, sender, etc.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query text (searches subject, body, sender, etc.)',
      },
      maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
    },
    required: ['query'],
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

    const query = args.query as string
    const maxResults = Math.min((args.maxResults as number) || 10, 100)

    const path = `/me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,isDraft,importance,hasAttachments,categories,parentFolderId`

    const response = await graphRequest('GET', path)
    const messages = (response.value || []).map((msg: any) => formatMessage(msg))

    return { account: email, query, count: messages.length, messages }
  },
}
