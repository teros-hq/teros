import type { ToolConfig } from '@teros/mca-sdk'
import { assertDisplayName, createGraphClient, formatSection, requireId } from '../lib'
import type { GraphSecrets } from '../lib'

export const createSection: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a section inside a OneNote notebook. Names may not contain ? * \\ / : < > | \' " # and are limited to 50 characters.',
  parameters: {
    type: 'object',
    properties: {
      parentNotebookId: {
        type: 'string',
        description:
          'Id of the notebook to create the section in, from list-notebooks. Also accepted as notebookId.',
      },
      notebookId: {
        type: 'string',
        description: 'Alias for parentNotebookId.',
      },
      displayName: {
        type: 'string',
        description: 'Section name. Max 50 characters; ? * \\ / : < > | \' " # are not allowed.',
      },
    },
    required: ['parentNotebookId', 'displayName'],
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
    const notebook = requireId(
      a,
      ['parentNotebookId', 'notebookId'],
      'the notebook to create the section in, from list-notebooks',
    )
    const displayName = assertDisplayName(a.displayName, 'section name')

    const created = await graphRequest<Record<string, any>>(
      'POST',
      `/me/onenote/notebooks/${notebook.encoded}/sections`,
      { displayName },
    )

    return {
      success: true,
      account: email,
      notebookId: notebook.id,
      section: formatSection(created),
    }
  },
}
