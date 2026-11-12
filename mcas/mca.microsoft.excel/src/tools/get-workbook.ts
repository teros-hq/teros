import type { ToolConfig } from '@teros/mca-sdk'
import {
  assertXlsx,
  createGraphClient,
  formatWorksheet,
  terminalRef,
  workbookItemRef,
  workbookRef,
} from '../lib'
import type { GraphSecrets } from '../lib'

const WORKBOOK_SELECT = 'id,name,size,webUrl,lastModifiedDateTime,file'

export const getWorkbook: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    "Get an Excel workbook: its file metadata and the list of worksheets it contains. Confirms the item is a usable .xlsx — this is the only tool that validates the extension when addressing by itemId, because it is the only one that fetches the item metadata; the others surface Graph's own error for a wrong item type.",
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
          'Workbook path relative to the drive root, e.g. "Finance/Budget.xlsx". Pass literal names, not pre-encoded ones.',
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
    const meta = await graphRequest<Record<string, any>>(
      'GET',
      `${terminalRef(workbookItemRef(a))}?$select=${WORKBOOK_SELECT}`,
    )

    if (!meta.file) {
      throw new Error(`"${meta.name}" is a folder, not a workbook.`)
    }
    assertXlsx(meta.name ?? '')

    const sheets = await graphRequest<{ value?: any[] }>('GET', `${workbookRef(a)}/worksheets`)
    const worksheets = (sheets.value || []).map((ws) => formatWorksheet(ws))

    return {
      account: email,
      id: meta.id,
      name: meta.name,
      size: meta.size,
      webUrl: meta.webUrl,
      lastModifiedDateTime: meta.lastModifiedDateTime,
      worksheetCount: worksheets.length,
      worksheets,
    }
  },
}
