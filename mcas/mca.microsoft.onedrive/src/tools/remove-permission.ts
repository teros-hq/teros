import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const removePermission: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  description:
    'Revoke a sharing grant or link on a OneDrive item. Use list-permissions to find the permission ID.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      permissionId: { type: 'string', description: 'The permission ID to revoke' },
    },
    required: ['permissionId'],
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
    await graphRequest(
      'DELETE',
      `${requireItemRef(a)}/permissions/${encodeURIComponent(a.permissionId as string)}`,
    )

    return { success: true, account: email, message: 'Permission revoked.' }
  },
}
