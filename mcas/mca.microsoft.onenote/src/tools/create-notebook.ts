import type { ToolConfig } from '@teros/mca-sdk'
import { assertDisplayName, createGraphClient, formatNotebook } from '../lib'
import type { GraphSecrets } from '../lib'

export const createNotebook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new OneNote notebook. Names may not contain ? * \\ / : < > | \' " # and are limited to 50 characters.',
  parameters: {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        description: 'Notebook name. Max 50 characters; ? * \\ / : < > | \' " # are not allowed.',
      },
    },
    required: ['displayName'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'OneNote',
      'Notes.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const displayName = assertDisplayName(a.displayName, 'notebook name')

    const created = await graphRequest<Record<string, any>>('POST', '/me/onenote/notebooks', {
      displayName,
    })

    return { success: true, account: email, notebook: formatNotebook(created) }
  },
}
