import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { SEARCH_FILE_HIT_FIELDS } from "./_fields"
import { extractSearchFileHit } from "./_helpers"
import { resolveFieldsList, sanitizeLimit, wrapSlackCall } from "./utils"

interface SearchFilesArgs {
  query: string
  sort?: "score" | "timestamp"
  sortDirection?: "asc" | "desc"
  count?: number
  page?: number
  highlight?: boolean
  fields?: string[]
  includeRaw?: boolean
}

export const searchFiles: ToolConfig = {
  description:
    "Search files workspace-wide. Supports Slack search syntax (in:#channel, from:@user, type:pdf). Returns curated hits { id, name, title, mimetype, permalink, thumbUrl, score, createdAt } + total + page. Params: query, sort? (score|timestamp), sortDirection?, count (1-100, def 20), page, highlight, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Slack search query (supports operators like type:pdf, in:#channel).",
      },
      sort: {
        type: "string",
        enum: ["score", "timestamp"],
        description: "Sort by relevance or time. Default score.",
      },
      sortDirection: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction. Default desc.",
      },
      count: {
        type: "number",
        description: "Results per page. Min 1, max 100, default 20.",
      },
      page: {
        type: "number",
        description: "Page number (1-indexed). Default 1.",
      },
      highlight: {
        type: "boolean",
        description: "Highlight matching terms. Default false.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per hit.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack search.files.matches[]. Default false.",
      },
    },
    required: ["query"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { query, sort, sortDirection, count, page, highlight, fields, includeRaw } =
      args as unknown as SearchFilesArgs
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("query must be a non-empty string.")
    }
    const pageSize = sanitizeLimit(count, { max: 100, default: 20 })
    const pageNumber = sanitizeLimit(page, { max: 100, default: 1 })

    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.search.files({
        query,
        sort: sort ?? "score",
        sort_dir: sortDirection ?? "desc",
        count: pageSize,
        page: pageNumber,
        highlight: highlight ?? false,
      }),
    )

    const rawMatches = result.files?.matches ?? []
    const shaped = rawMatches.map(extractSearchFileHit)
    const matches = resolveFieldsList(shaped as any, rawMatches, {
      includeRaw,
      fields,
      defaultFields: SEARCH_FILE_HIT_FIELDS,
    })

    return {
      matches,
      total: result.files?.total ?? matches.length,
      page: pageNumber,
      pagination: result.files?.pagination ?? null,
    }
  },
}
