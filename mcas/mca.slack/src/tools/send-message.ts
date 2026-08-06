import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractMessage } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface SendMessageArgs {
  channel: string
  text: string
  blocks?: string
  threadTs?: string
  unfurlLinks?: boolean
  unfurlMedia?: boolean
}

/**
 * Build a permalink without a second API call. The Slack archives URL format
 * is documented and stable: `https://<workspace>.slack.com/archives/<channel>/p<tsNoDot>`.
 */
function buildPermalink(domain: string, channel: string, ts: string): string | null {
  if (!domain || !channel || !ts) return null
  const tsNumeric = ts.replace(".", "")
  return `https://${domain}.slack.com/archives/${channel}/p${tsNumeric}`
}

export const sendMessage: ToolConfig = {
  description:
    "Post a message to a channel, DM, or as a top-level message. Returns { ts, channel, message, permalink }. Not retryable (no idempotency key — duplicate messages on retry). Params: channel, text, blocks? (JSON), threadTs?, unfurlLinks (def true), unfurlMedia (def true).",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id (C... / G... / D... / M...) or user id (U... for DM).",
      },
      text: {
        type: "string",
        description: "Plain text body. Required even when blocks are provided (used as fallback).",
      },
      blocks: {
        type: "string",
        description: "Optional Slack Block Kit JSON string (will be parsed).",
      },
      threadTs: {
        type: "string",
        description: "Parent message ts to post as a thread reply. Use send-thread-reply for the canonical thread API.",
      },
      unfurlLinks: {
        type: "boolean",
        description: "Unfurl links in the message. Default true.",
      },
      unfurlMedia: {
        type: "boolean",
        description: "Unfurl media in the message. Default true.",
      },
    },
    required: ["channel", "text"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, text, blocks, threadTs, unfurlLinks, unfurlMedia } = args as unknown as SendMessageArgs
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("text must be a non-empty string.")
    }
    let parsedBlocks: unknown[] | undefined
    if (typeof blocks === "string" && blocks.trim().length > 0) {
      try {
        const parsed = JSON.parse(blocks)
        if (!Array.isArray(parsed)) {
          throw new Error("blocks must parse to a JSON array.")
        }
        parsedBlocks = parsed
      } catch (err) {
        throw new Error(
          `Invalid blocks JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const session = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      session.client.chat.postMessage(
        sanitiseBody({
          channel,
          text,
          blocks: parsedBlocks,
          thread_ts: threadTs,
          unfurl_links: unfurlLinks ?? true,
          unfurl_media: unfurlMedia ?? true,
        }) as any,
      ),
    )

    const ts = result.ts ?? ""
    const resolvedChannel = result.channel ?? channel
    const domain = session.teamName ? "" : "" // teamName is the friendly label; domain comes from team.info
    // Permalink without a second call requires the workspace domain. We have
    // teamName but not the domain in session — leave permalink null and let
    // the renderer call get-team-info on first use. A future optimisation
    // could hydrate the domain into the cached session.
    const permalink = buildPermalink(domain, resolvedChannel, ts)

    return {
      ts,
      channel: resolvedChannel,
      message: result.message ? extractMessage(result.message, { channel: resolvedChannel }) : null,
      permalink,
    }
  },
}
