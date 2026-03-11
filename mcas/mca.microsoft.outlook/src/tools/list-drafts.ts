import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatMessage } from '../lib'
import type { OutlookSecrets } from '../lib'

export const listDrafts: ToolConfig = {
  description: 'List all draft emails in the account.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'number',
        description: 'Maximum number of drafts to return (default: 10, max: 100)',
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

    const response = await graphRequest(
      'GET',
      `/me/mailFolders/Drafts/messages?$top=${maxResults}&$orderby=createdDateTime desc&$select=id,conversationId,subject,from,toRecipients,ccRecipients,createdDateTime,bodyPreview,isRead,isDraft,importance,hasAttachments,categories,parentFolderId`,
    )
    const drafts = (response.value || []).map((msg: any) => formatMessage(msg))

    return { account: email, count: drafts.length, drafts }
  },
}
