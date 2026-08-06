import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface SearchMessagesArgs {
  query: string
  sort?: "score" | "timestamp"
  sortDirection?: "asc" | "desc"
  count?: number
  page?: number
  highlight?: boolean
}

export const searchMessages: ToolConfig = {
  description: "Search messages across the Slack workspace.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Supports Slack search syntax: in:#channel, from:@user, before/after dates, etc.",
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
    const { query, sort, sortDirection, count, page, highlight } = (args as unknown) as SearchMessagesArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.search.messages({
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

      const matches = (result.messages?.matches ?? []).map((m: any) => ({
        type: m.type,
        channel: {
          id: m.channel?.id ?? "",
          name: m.channel?.name ?? "",
          isPrivate: m.channel?.is_private ?? false,
        },
        ts: m.ts,
        text: m.text ?? "",
        permalink: m.permalink ?? "",
        user: m.username ?? m.user ?? "",
        team: m.team ?? "",
        score: m.score,
      }))

      return {
        matches,
        total: result.messages?.total ?? 0,
        pagination: result.messages?.pagination ?? {},
        page: page ?? 1,
      }
    } catch (error) {
      handleSlackError(error, "search messages")
    }
  },
}
