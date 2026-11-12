import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import { createGraphClient, encodePathSegments } from '../lib'

/** list-documents — discover .docx files in a OneDrive folder. */
export const listDocuments: ToolConfig = {
    description:
      'List Word (.docx) documents in a OneDrive folder. Defaults to the drive root. Use the optional query to filter by filename (case-insensitive substring). Returns id, name, size, lastModifiedDateTime, and webUrl for each document.',
    parameters: {
      type: 'object',
      properties: {
        folderPath: {
          type: 'string',
          description:
            'Path to the folder to list, relative to the drive root. Pass literal names, not pre-encoded ones. Defaults to the drive root.',
        },
        query: {
          type: 'string',
          description:
            'Filter results by filename (case-insensitive substring match).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Default 50, max 200.',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All')

      const a = (args ?? {}) as Record<string, unknown>

      // Resolve limit — default 50, clamp to [1, 200]
      const rawLimit = typeof a.limit === 'number' ? a.limit : 50
      const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)))

      // Build the children endpoint URL
      const folderPath = typeof a.folderPath === 'string' ? a.folderPath.trim() : ''
      const select = 'id,name,size,lastModifiedDateTime,webUrl'
      const childrenPath = folderPath
        ? `/me/drive/root:/${encodePathSegments(folderPath)}:/children?$select=${select}&$top=${limit}`
        : `/me/drive/root/children?$select=${select}&$top=${limit}`

      let response: { value?: Array<Record<string, any>> }
      try {
        response = await graphRequest<{ value?: Array<Record<string, any>> }>('GET', childrenPath)
      } catch (error: any) {
        // Graph returns 404 when the folder doesn't exist — surface a clear message
        if (error?.message?.includes('404') || error?.message?.includes('notFound') || error?.message?.includes('resourceNotFound')) {
          throw new Error(`Folder "${folderPath}" was not found in OneDrive. Check the path and try again.`)
        }
        throw error
      }

      const allItems = response?.value ?? []

      // Filter to .docx files only (client-side — Graph $filter doesn't support endsWith on name)
      let documents = allItems.filter((item) => {
        const name = item?.name
        return typeof name === 'string' && /\.docx$/i.test(name)
      })

      // If query is provided, further filter by case-insensitive substring match on name
      const query = typeof a.query === 'string' ? a.query.trim() : ''
      if (query) {
        const lowerQuery = query.toLowerCase()
        documents = documents.filter((item) => {
          const name = item?.name
          return typeof name === 'string' && name.toLowerCase().includes(lowerQuery)
        })
      }

      // Shape the output
      const shaped = documents.map((item) => ({
        id: item?.id ?? null,
        name: item?.name ?? null,
        size: item?.size ?? null,
        lastModifiedDateTime: item?.lastModifiedDateTime ?? null,
        webUrl: item?.webUrl ?? null,
      }))

      return {
        account: email,
        count: shaped.length,
        documents: shaped,
      }
    },
  }
