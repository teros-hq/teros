import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatNotebook, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const getNotebook: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get one OneNote notebook by id, with its name, sharing state, and web URL.',
  parameters: {
    type: 'object',
    properties: {
      notebookId: {
        type: 'string',
        description: 'Notebook id, as returned by list-notebooks.',
      },
    },
    required: ['notebookId'],
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
    const notebook = requireId(a, ['notebookId'], 'the notebook id from list-notebooks')

    const found = await graphRequest<Record<string, any>>(
      'GET',
      `/me/onenote/notebooks/${notebook.encoded}`,
    )

    return { account: email, notebook: formatNotebook(found) }
  },
}
