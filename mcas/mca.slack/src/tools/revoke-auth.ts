import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface RevokeAuthArgs {
  test?: boolean
}

export const revokeAuth: ToolConfig = {
  description:
    "Revoke the current OAuth token (logs the user out of this Slack workspace from Teros). Returns { revoked: true }. Not retryable — destructive. Params: test (def false — set true to validate without actually revoking).",
  parameters: {
    type: "object",
    properties: {
      test: {
        type: "boolean",
        description: "If true, simulate without revoking (for validation). Default false.",
      },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { test } = args as unknown as RevokeAuthArgs
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.auth.revoke(sanitiseBody({ test: test ?? false }) as any),
    )
    return {
      revoked: (result as any).revoked ?? !test,
      test: test ?? false,
    }
  },
}
