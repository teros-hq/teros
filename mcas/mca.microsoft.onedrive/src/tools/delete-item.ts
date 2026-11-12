import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const deleteItem: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  description:
    'Delete a OneDrive file or folder. The item moves to the recycle bin, but this app cannot restore it.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
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
    await graphRequest('DELETE', requireItemRef(a))

    return {
      success: true,
      account: email,
      message: 'Item moved to the OneDrive recycle bin.',
    }
  },
}
