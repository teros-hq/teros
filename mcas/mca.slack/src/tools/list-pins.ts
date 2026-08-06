import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractMessage, extractFile, tsToIso, validateChannelId } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface ListPinsArgs {
  channel: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedPin {
  type: "message" | "file"
  createdAt: string | null
  createdBy: string | null
  message?: ReturnType<typeof extractMessage> | null
  file?: ReturnType<typeof extractFile> | null
}

export const listPins: ToolConfig = {
  description:
    "List items pinned to a channel (messages and files). Returns { pins: [{ type, createdAt, createdBy, message? | file? }], count }. Retryable. Params: channel.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id whose pins to list." },
    },
    required: ["channel"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, includeRaw} = args as unknown as ListPinsArgs
    validateChannelId(channel, "channel")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.pins.list({ channel }))
    if (includeRaw) return result
    const items = (result.items ?? []) as any[]
    const pins: CuratedPin[] = items.map((it) => {
      const base = {
        type: it.type as "message" | "file",
        createdAt: tsToIso(it.created),
        createdBy: it.created_by ?? null,
      }
      if (it.type === "message" && it.message) {
        return { ...base, message: extractMessage(it.message, { channel }) }
      }
      if (it.type === "file" && it.file) {
        return { ...base, file: extractFile(it.file) }
      }
      return base
    })
    return {
      pins,
      count: pins.length,
    }
  },
}
