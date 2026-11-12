import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolConfig } from '@teros/mca-sdk'
import { assertSize, createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const convertFile: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'Convert a OneDrive document (Word, Excel, PowerPoint, and other supported types) to PDF and save it locally. Files above 50 MB are refused.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'File path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      outputPath: {
        type: 'string',
        description: 'Output directory (default: /workspace/onedrive-downloads)',
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
    const outputPath = (a.outputPath as string) || '/workspace/onedrive-downloads'
    const base = requireItemRef(a)

    const meta = await graphRequest<Record<string, any>>(
      'GET',
      `${base}?$select=id,name,size,file,folder`,
    )
    if (meta.folder) {
      throw new Error(`"${meta.name}" is a folder. convert-file only handles files.`)
    }
    assertSize(meta.size ?? 0, `"${meta.name}"`)

    const buffer: Buffer = await graphRequest<Buffer>(
      'GET',
      `${base}/content?format=pdf`,
      undefined,
      { responseType: 'buffer' },
    )

    const pdfName = `${meta.name.replace(/\.[^.]+$/, '')}.pdf`
    mkdirSync(outputPath, { recursive: true })
    const filePath = join(outputPath, pdfName)
    writeFileSync(filePath, buffer)

    return {
      success: true,
      account: email,
      source: meta.name,
      name: pdfName,
      savedTo: filePath,
      size: buffer.length,
    }
  },
}
