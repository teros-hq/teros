import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId } from "./_helpers"
import { SlackApiError } from "./_slack-error"
import { wrapSlackMutation } from "./utils"

interface ShareFilePublicArgs {
  fileId: string
}

export const shareFilePublic: ToolConfig = {
  description:
    "Make a file publicly accessible via URL (anyone with link can view, no login). Returns { fileId, permalinkPublic }. Not retryable. Params: fileId (F...).",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Slack file id." },
    },
    required: ["fileId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { fileId } = args as unknown as ShareFilePublicArgs
    if (!isFileId(fileId)) {
      throw new Error(`Invalid fileId: expected F..., got "${fileId}"`)
    }
    const { client } = await getSlackSession(context)
    // Slack Free workspaces forbid `files.sharedPublicURL` and surface this as
    // a generic `not_allowed` error code. The transversal classifier maps
    // `not_allowed` to BUSINESS_RULE (the conservative choice since the same
    // code is reused for per-resource permission denials elsewhere). For THIS
    // tool we know the only realistic cause is plan-gating, so reclassify
    // explicitly as FEATURE_GATED with plan-specific guidance. Other
    // not_allowed contexts in this MCA keep the BUSINESS_RULE mapping.
    let result: unknown
    try {
      result = await wrapSlackMutation(() => client.files.sharedPublicURL({ file: fileId }))
    } catch (err) {
      if (err instanceof SlackApiError && err.upstreamMessage === "not_allowed") {
        throw new SlackApiError({
          code: "FEATURE_GATED",
          action: {
            type: "admin_action",
            description:
              "Public file sharing is disabled on this Slack workspace. The Free plan does not include public file URLs; admins may also disable it on paid plans. Upgrade the plan or have an admin enable public file sharing in workspace settings.",
          },
          retryable: false,
          httpStatus: err.httpStatus,
          upstreamMessage: "not_allowed",
        })
      }
      throw err
    }
    return {
      fileId,
      permalinkPublic: (result as any).file?.permalink_public ?? null,
    }
  },
}
