import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, encodePathSegments, normalizePath } from '../lib'
import type { GraphSecrets } from '../lib'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** A minimal valid empty .xlsx. A zero-byte file is not a usable workbook. */
const TEMPLATE_PATH = join(__dirname, '..', '..', 'assets', 'empty-workbook.xlsx')

export const createWorkbook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new, empty Excel workbook in OneDrive. Fails if a file already exists at that path unless overwrite is set. This is not a workbook API call: it uploads an empty .xlsx, after which the workbook endpoints become available on that item. Returns the drive item, whose id addresses every other Excel tool.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'File name for the new workbook. ".xlsx" is appended if missing. Pass a literal name, not a pre-encoded one.',
      },
      parentPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root, e.g. "Finance". Defaults to the drive root. Pass literal folder names, not pre-encoded ones.',
      },
      overwrite: {
        type: 'boolean',
        description:
          'When true, replaces any existing file at that path with a new empty workbook, discarding its contents permanently. Defaults to false, which fails instead.',
      },
    },
    required: ['name'],
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
    if (typeof a.name !== 'string' || !a.name.trim()) {
      throw new Error('Specify name for the new workbook, for example "Budget.xlsx".')
    }
    const rawName = a.name.trim()
    const name = rawName.toLowerCase().endsWith('.xlsx') ? rawName : `${rawName}.xlsx`
    const folder = encodePathSegments(normalizePath((a.parentPath as string) || ''))
    const target = `/me/drive/root:${folder}/${encodeURIComponent(name)}:`

    const conflictBehavior = a.overwrite === true ? 'replace' : 'fail'

    const template = readFileSync(TEMPLATE_PATH)
    const workbook = await graphRequest<Record<string, unknown>>(
      'PUT',
      `${target}/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      undefined,
      { headers: { 'Content-Type': 'application/octet-stream' }, rawBody: template },
    )

    return {
      success: true,
      account: email,
      workbook: {
        id: (workbook as any).id,
        name: (workbook as any).name,
        size: (workbook as any).size,
        webUrl: (workbook as any).webUrl,
      },
    }
  },
}
