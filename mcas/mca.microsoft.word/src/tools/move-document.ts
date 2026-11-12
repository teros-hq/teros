import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  createGraphClient,
  encodePathSegments,
  formatItem,
  itemRef,
  normalizePath,
} from '../lib'

/** move-document — moves a .docx to a different folder. */
export const moveDocument: ToolConfig = {
  description:
    'Move a Word document to a different folder in OneDrive. The document keeps its current name.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'OneDrive item id of the .docx to move. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      destinationFolderPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
    },
    required: ['destinationFolderPath'],
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

    const destinationFolderPath =
      typeof a.destinationFolderPath === 'string' ? a.destinationFolderPath.trim() : ''
    if (!destinationFolderPath) {
      throw new Error('Specify destinationFolderPath — the folder to move the document into.')
    }

    // Build the parentReference path Graph expects: /drive/root:/folder/subfolder
    const encoded = encodePathSegments(normalizePath(destinationFolderPath))

    const moved = await graphRequest<Record<string, any>>('PATCH', ref, {
      parentReference: { path: `/drive/root:/${encoded}` },
    })

    return {
      success: true,
      account: email,
      item: formatItem(moved),
    }
  },
}
