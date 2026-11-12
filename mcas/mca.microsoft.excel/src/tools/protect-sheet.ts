import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const protectSheet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Protect a worksheet to prevent accidental edits, or remove protection. Use unprotect:true to unprotect the sheet. When protecting, you can optionally specify allowed operations.',
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
      worksheet: { type: 'string', description: 'Worksheet name or id' },
      unprotect: {
        type: 'boolean',
        description: 'When true, remove protection from the worksheet instead of applying it.',
      },
      allowFormatCells: {
        type: 'boolean',
        description: 'Allow formatting cells while protected (default: false).',
      },
      allowInsertColumns: {
        type: 'boolean',
        description: 'Allow inserting columns while protected (default: false).',
      },
      allowInsertRows: {
        type: 'boolean',
        description: 'Allow inserting rows while protected (default: false).',
      },
      allowDeleteColumns: {
        type: 'boolean',
        description: 'Allow deleting columns while protected (default: false).',
      },
      allowDeleteRows: {
        type: 'boolean',
        description: 'Allow deleting rows while protected (default: false).',
      },
      allowSort: {
        type: 'boolean',
        description: 'Allow sorting while protected (default: false).',
      },
      allowAutoFilter: {
        type: 'boolean',
        description: 'Allow using auto-filter while protected (default: false).',
      },
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
    const wsRef = worksheetRef(a)

    if (a.unprotect === true) {
      await graphRequest('POST', `${wsRef}/protection/unprotect`)
      return {
        success: true,
        account: email,
        worksheet: a.worksheet as string,
        action: 'unprotected',
      }
    }

    const options: Record<string, boolean> = {
      allowFormatCells: a.allowFormatCells === true,
      allowInsertColumns: a.allowInsertColumns === true,
      allowInsertRows: a.allowInsertRows === true,
      allowDeleteColumns: a.allowDeleteColumns === true,
      allowDeleteRows: a.allowDeleteRows === true,
      allowSort: a.allowSort === true,
      allowAutoFilter: a.allowAutoFilter === true,
    }

    await graphRequest('POST', `${wsRef}/protection/protect`, options)

    return {
      success: true,
      account: email,
      worksheet: a.worksheet as string,
      action: 'protected',
      options,
    }
  },
}
