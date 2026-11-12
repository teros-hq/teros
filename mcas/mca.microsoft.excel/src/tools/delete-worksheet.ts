import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const deleteWorksheet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a worksheet and everything on it. This cannot be undone by this app — the workbook must be restored from OneDrive version history.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'Workbook drive item ID. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Workbook path relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      worksheet: { type: 'string', description: 'Worksheet name or id to delete' },
    },
    required: ['worksheet'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'Excel',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    await graphRequest('DELETE', worksheetRef(a))

    return {
      success: true,
      account: email,
      message: 'Worksheet deleted. Recover it from OneDrive version history if needed.',
    }
  },
}
