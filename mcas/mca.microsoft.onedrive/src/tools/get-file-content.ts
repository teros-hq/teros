import type { ToolConfig } from '@teros/mca-sdk'
import { assertSize, createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

const MAX_INLINE_BYTES = 1024 * 1024

const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
])

function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return true
  const type = mimeType.split(';')[0].trim().toLowerCase()
  if (type.startsWith('text/')) return true
  if (TEXTUAL_APPLICATION_TYPES.has(type)) return true
  if (type.endsWith('+json') || type.endsWith('+xml')) return true
  return false
}

export const getFileContent: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'Read the contents of a text-based OneDrive file inline, without saving it to disk. Limited to 1 MB.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'File path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
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

    const meta = await graphRequest<Record<string, any>>(
      'GET',
      `${base}?$select=id,name,size,file`,
    )
    assertSize(meta.size ?? 0, `"${meta.name}"`)
    if ((meta.size ?? 0) > MAX_INLINE_BYTES) {
      throw new Error(
        `"${meta.name}" is larger than 1 MB. Use download-file to save it to disk instead.`,
      )
    }
    if (!isTextMimeType(meta.file?.mimeType)) {
      throw new Error(
        `"${meta.name}" is ${meta.file.mimeType}, which is not text. Use download-file to save it to disk instead.`,
      )
    }

    const buffer: Buffer = await graphRequest<Buffer>('GET', `${base}/content`, undefined, {
      responseType: 'buffer',
    })

    return {
      account: email,
      name: meta.name,
      mimeType: meta.file?.mimeType,
      size: meta.size,
      content: buffer.toString('utf-8'),
    }
  },
}
