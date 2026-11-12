import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const renameItem: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: 'Rename a OneDrive file or folder without moving it.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      newName: { type: 'string', description: 'The new name for the item' },
    },
    required: ['newName'],
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
    const renamed = await graphRequest<Record<string, any>>('PATCH', requireItemRef(a), {
      name: a.newName as string,
    })

    return { success: true, account: email, item: formatItem(renamed) }
  },
}
