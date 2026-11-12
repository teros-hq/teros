import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, workbookRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const calculateWorkbook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Force Excel to recalculate a workbook. Use after writing formulas if dependent cells still show stale values.',
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
      calculationType: {
        type: 'string',
        description:
          'Calculation scope: "Recalculate" (default, changed cells only), "Full", or "FullRebuild".',
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
      'Excel',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const calculationType = (a.calculationType as string) || 'Recalculate'

    await graphRequest('POST', `${workbookRef(a)}/application/calculate`, { calculationType })

    return { success: true, account: email, calculationType }
  },
}
