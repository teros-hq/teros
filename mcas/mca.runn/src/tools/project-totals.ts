import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnProjectTotals, runnList } from "../lib"
import { PROJECT_TOTALS_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit } from "./utils"

export const projectTotals: ToolConfig = {
  description:
    "Get aggregated minute totals per project (billable, non-billable, total — from actuals when available, falling back to assignments). Returns { items: [{ id, billableMinutes, nonBillableMinutes, totalMinutes, assignments, actuals }], total, hasMore, nextCursor }. Params: includeArchived (default false), limit (1-10, def 10), cursor?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      includeArchived: {
        type: "boolean",
        description: "Include archived projects in the totals. Default false.",
      },
      limit: { type: "number", description: "Results per page. Min 1, max 10, default 10." },
      cursor: {
        type: "string",
        description: "Pagination cursor from a previous response.nextCursor.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Runn aggregate objects. Default false.",
      },
    },
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { includeArchived, limit, cursor, fields, includeRaw } = args as {
      includeArchived?: boolean
      limit?: number
      cursor?: string
      fields?: string[]
      includeRaw?: boolean
    }

    const page = await runnList<RunnProjectTotals>("/reports/totals/projects", context, {
      limit: sanitizeLimit(limit, { max: 10, default: 10 }),
      cursor,
      query: { includeArchived: includeArchived ?? false },
    })
    const items = resolveFieldsList(page.values as any, page.values, {
      includeRaw,
      fields,
      defaultFields: PROJECT_TOTALS_FIELDS,
    })
    return {
      items,
      total: items.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    }
  },
}
