import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const listRules: ToolConfig = {
  description: 'List all inbox rules (mail filters) for the account.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as OutlookSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
    )

    const response = await graphRequest('GET', '/me/mailFolders/Inbox/messageRules')

    return { account: email, count: (response.value || []).length, rules: response.value || [] }
  },
}
