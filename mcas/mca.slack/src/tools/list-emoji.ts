import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackCall } from "./utils"

interface CuratedEmoji {
  name: string
  url: string
  isAlias: boolean
  aliasFor: string | null
}

export const listEmoji: ToolConfig = {
  description:
    "List custom workspace emojis. Returns { emojis: [{ name, url, isAlias, aliasFor }], count }. Retryable. No params.",
  parameters: { type: "object", properties: {} },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.emoji.list())
    if ((args as any).includeRaw) return result
    const rawEmoji = ((result as any).emoji ?? {}) as Record<string, string>
    const emojis: CuratedEmoji[] = Object.entries(rawEmoji).map(([name, url]) => {
      const isAlias = url.startsWith("alias:")
      return {
        name,
        url,
        isAlias,
        aliasFor: isAlias ? url.slice("alias:".length) : null,
      }
    })
    return { emojis, count: emojis.length }
  },
}
