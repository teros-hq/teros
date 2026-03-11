import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatMessage } from '../lib'
import type { OutlookSecrets } from '../lib'

export const listMessages: ToolConfig = {
  description:
    'List email messages from inbox or a specific folder. Supports filtering by unread, importance, etc.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'number',
        description: 'Maximum number of messages to return (default: 10, max: 100)',
      },
      folderId: {
        type: 'string',
        description:
          'Mail folder ID or well-known name (e.g., "Inbox", "SentItems", "Drafts", "DeletedItems", "Archive"). Defaults to Inbox.',
      },
      filter: {
        type: 'string',
        description: 'OData $filter expression (e.g., "isRead eq false", "importance eq \'high\'")',
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

    const maxResults = Math.min((args.maxResults as number) || 10, 100)
    const folderId = (args.folderId as string) || 'Inbox'
    const filter = args.filter as string | undefined

    let path = `/me/mailFolders/${folderId}/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,isDraft,importance,hasAttachments,categories,parentFolderId`

    if (filter) {
      path += `&$filter=${encodeURIComponent(filter)}`
    }

    const response = await graphRequest('GET', path)
    const messages = (response.value || []).map((msg: any) => formatMessage(msg))

    return { account: email, count: messages.length, messages }
  },
}
