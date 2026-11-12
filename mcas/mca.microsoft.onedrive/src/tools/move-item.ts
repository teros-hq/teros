import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, destinationRef, formatItem, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const moveItem: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'Move a OneDrive file or folder into a different folder. Specify the item with itemId or path, and the destination with destinationFolderId or destinationPath; with neither destination, the item is moved to the drive root.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID to move. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Path of the item to move, relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      destinationFolderId: {
        type: 'string',
        description: 'Destination folder ID. Takes precedence over destinationPath.',
      },
      destinationPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root. Pass literal folder names, not pre-encoded ones. Omitting both destination arguments moves the item to the drive root.',
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
    const base = requireItemRef(a)

    const moved = await graphRequest<Record<string, any>>('PATCH', base, {
      parentReference: destinationRef(a),
    })

    return { success: true, account: email, item: formatItem(moved) }
  },
}
