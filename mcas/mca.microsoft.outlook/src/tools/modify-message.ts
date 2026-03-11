import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const modifyMessage: ToolConfig = {
  description:
    'Modify a message: mark as read/unread, set importance, add categories, or flag it.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to modify' },
      isRead: { type: 'boolean', description: 'Mark as read (true) or unread (false)' },
      importance: { type: 'string', description: 'Set importance: low, normal, high' },
      categories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Set category labels (replaces existing)',
      },
      flag: {
        type: 'string',
        description: 'Set flag status: notFlagged, flagged, complete',
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
    const updates: any = {}

    if (args.isRead !== undefined) updates.isRead = args.isRead as boolean
    if (args.importance) updates.importance = args.importance as string
    if (args.categories) updates.categories = args.categories as string[]
    if (args.flag) updates.flag = { flagStatus: args.flag as string }

    await graphRequest('PATCH', `/me/messages/${messageId}`, updates)

    return { success: true, account: email, messageId, updates }
  },
}
