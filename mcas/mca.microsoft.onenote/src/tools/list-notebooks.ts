import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatNotebook } from '../lib'
import type { GraphSecrets } from '../lib'

export const listNotebooks: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List every OneNote notebook the signed-in account can open, including shared ones.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
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

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      '/me/onenote/notebooks?$orderby=displayName',
    )
    const notebooks = (response.value || []).map((n) => formatNotebook(n))

    return { account: email, count: notebooks.length, notebooks }
  },
}
