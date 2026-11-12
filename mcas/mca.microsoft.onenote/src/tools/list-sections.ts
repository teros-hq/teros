import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatSection, optionalId, SECTION_EXPAND } from '../lib'
import type { GraphSecrets } from '../lib'

export const listSections: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    "List OneNote sections. Scoped to one notebook when notebookId is given, this returns only that notebook's top-level sections — sections nested inside a section group are not included. Omit notebookId to list every section the account can reach, section groups included.",
  parameters: {
    type: 'object',
    properties: {
      notebookId: {
        type: 'string',
        description:
          "Optional notebook id from list-notebooks. Returns only that notebook's top-level sections — sections inside a section group are not included. Omit to list sections across all notebooks, including ones inside section groups.",
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
      ? `/me/onenote/notebooks/${notebook.encoded}/sections`
      : '/me/onenote/sections'

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `${base}?$expand=${SECTION_EXPAND}&$orderby=displayName`,
    )
    const sections = (response.value || []).map((s) => formatSection(s))

    return { account: email, notebookId: notebook?.id ?? null, count: sections.length, sections }
  },
}
