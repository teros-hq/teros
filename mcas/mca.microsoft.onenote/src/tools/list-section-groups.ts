import type { ToolConfig } from '@teros/mca-sdk'
import {
  createGraphClient,
  formatSectionGroup,
  optionalId,
  SECTION_GROUP_EXPAND,
} from '../lib'
import type { GraphSecrets } from '../lib'

export const listSectionGroups: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List OneNote section groups — the folders that hold sections inside a notebook. Scoped to one notebook when notebookId is given.',
  parameters: {
    type: 'object',
    properties: {
      notebookId: {
        type: 'string',
        description:
          'Optional notebook id from list-notebooks. Omit to list section groups across all notebooks.',
      },
    },
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
    const notebook = optionalId(a, ['notebookId'])
    const base = notebook
      ? `/me/onenote/notebooks/${notebook.encoded}/sectionGroups`
      : '/me/onenote/sectionGroups'

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `${base}?$expand=${SECTION_GROUP_EXPAND}&$orderby=displayName`,
    )
    const sectionGroups = (response.value || []).map((g) => formatSectionGroup(g))

    return {
      account: email,
      notebookId: notebook?.id ?? null,
      count: sectionGroups.length,
      sectionGroups,
    }
  },
}
