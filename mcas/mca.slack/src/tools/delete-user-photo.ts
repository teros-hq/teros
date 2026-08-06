import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

export const deleteUserPhoto: ToolConfig = {
  description:
    "Delete the authenticated user's profile photo (replaces with default avatar). Returns { deleted: true }. Not retryable. No params.",
  parameters: { type: "object", properties: {} },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (_args, context) => {
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => (client as any).users.deletePhoto())
    return { deleted: true }
  },
}
