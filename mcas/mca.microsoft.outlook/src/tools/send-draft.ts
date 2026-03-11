import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const sendDraft: ToolConfig = {
  description: 'Send an existing draft email.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'The ID of the draft to send' },
    },
    required: ['draftId'],
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

    const draftId = args.draftId as string
    await graphRequest('POST', `/me/messages/${draftId}/send`)

    return { success: true, account: email, draftId }
  },
}
