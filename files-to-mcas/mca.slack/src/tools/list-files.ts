import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface ListFilesArgs {
  channel?: string
  user?: string
  limit?: number
  page?: number
  tsFrom?: string
  tsTo?: string
  types?: string
}

export const listFiles: ToolConfig = {
  description: "List files uploaded to the Slack workspace. Supports filtering by channel, user, and time range.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Filter by channel ID",
      },
      user: {
        type: "string",
        description: "Filter by user ID",
      },
      limit: {
        type: "number",
        description: "Max files (1-100). Default: 20",
      },
      page: {
        type: "number",
        description: "Page number for pagination. Default: 1",
      },
      tsFrom: {
        type: "string",
        description: "Filter files created after this timestamp (Unix format)",
      },
      tsTo: {
        type: "string",
        description: "Filter files created before this timestamp (Unix format)",
      },
      types: {
        type: "string",
        description: "Filter by file type: all, spaces, snippets, images, gdocs, zips, pdfs. Default: all",
      },
    },
  },
  handler: async (args, context) => {
    const { channel, user, limit, page, tsFrom, tsTo, types } = (args as unknown) as ListFilesArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.files.list({
        channel,
        user,
        count: limit ?? 20,
        page: page ?? 1,
        ts_from: tsFrom,
        ts_to: tsTo,
        types: types ?? "all",
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const files = (result.files ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        title: f.title ?? f.name,
        mimetype: f.mimetype,
        size: f.size,
        url: f.url_private ?? f.permalink ?? "",
        permalink: f.permalink ?? "",
        created: f.created,
        user: f.user,
        channels: f.channels ?? [],
        isExternal: f.is_external ?? false,
        isPublic: f.is_public ?? false,
        editable: f.editable ?? false,
      }))

      return {
        files,
        paging: result.paging ?? { count: 0, total: 0, page: 1, pages: 1 },
        total: files.length,
      }
    } catch (error) {
      handleSlackError(error, "list files")
    }
  },
}
