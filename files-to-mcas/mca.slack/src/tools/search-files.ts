import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface SearchFilesArgs {
  query: string
  sort?: "score" | "timestamp"
  sortDirection?: "asc" | "desc"
  count?: number
  page?: number
  highlight?: boolean
}

export const searchFiles: ToolConfig = {
  description: "Search files across the Slack workspace.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Supports Slack search syntax: in:#channel, from:@user, type:pdf, etc.",
      },
      sort: {
        type: "string",
        enum: ["score", "timestamp"],
        description: "Sort by relevance (score) or time (timestamp). Default: score",
      },
      sortDirection: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction. Default: desc",
      },
      count: {
        type: "number",
        description: "Results per page (1-100). Default: 20",
      },
      page: {
        type: "number",
        description: "Page number. Default: 1",
      },
      highlight: {
        type: "boolean",
        description: "Highlight matching terms. Default: false",
      },
    },
    required: ["query"],
  },
  handler: async (args, context) => {
    const { query, sort, sortDirection, count, page, highlight } = (args as unknown) as SearchFilesArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.search.files({
        query,
        sort: sort ?? "score",
        sort_dir: sortDirection ?? "desc",
        count: count ?? 20,
        page: page ?? 1,
        highlight: highlight ?? false,
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const matches = (result.files?.matches ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        title: f.title ?? f.name,
        mimetype: f.mimetype,
        size: f.size,
        url: f.url_private ?? f.permalink ?? "",
        permalink: f.permalink ?? "",
        created: f.created,
        user: f.user ?? "",
        channels: f.channels ?? [],
        isExternal: f.is_external ?? false,
        score: f.score,
      }))

      return {
        matches,
        total: result.files?.total ?? 0,
        pagination: result.files?.pagination ?? {},
        page: page ?? 1,
      }
    } catch (error) {
      handleSlackError(error, "search files")
    }
  },
}
