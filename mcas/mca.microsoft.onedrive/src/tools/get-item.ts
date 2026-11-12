import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem, ITEM_SELECT, itemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const getItem: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'Get metadata for a single OneDrive file or folder, addressed by itemId or by path.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root, e.g. "Documents/notes.txt". Pass literal file and folder names, not pre-encoded ones.',
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
      'OneDrive',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const item = await graphRequest<Record<string, any>>(
      'GET',
      `${itemRef(a)}?$select=${ITEM_SELECT}`,
    )

    return { account: email, item: formatItem(item) }
  },
}
