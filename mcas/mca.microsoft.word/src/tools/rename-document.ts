import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import { assertDocxName, createGraphClient, formatItem, itemRef } from '../lib'

/** rename-document — renames a .docx without moving it. */
export const renameDocument: ToolConfig = {
  description:
    'Rename a Word document without moving it. The new name must end in .docx. Returns the updated item metadata.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'OneDrive item id of the .docx. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      newName: {
        type: 'string',
        description: 'The new file name, ending in .docx.',
      },
    },
    required: ['newName'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'Word',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const ref = itemRef(a)

    const newName = typeof a.newName === 'string' ? a.newName.trim() : ''
    if (!newName) {
      throw new Error('Specify newName — the new file name for the document.')
    }
    assertDocxName(newName)

    const renamed = await graphRequest<Record<string, any>>('PATCH', ref, {
      name: newName,
    })

    return {
      success: true,
      account: email,
      item: formatItem(renamed),
    }
  },
}
