import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackCall } from "./utils"

interface CuratedIdentity {
  userId: string | null
  name: string | null
  email: string | null
  teamId: string | null
  teamName: string | null
  teamDomain: string | null
  imageUrl: string | null
}

export const getUserIdentity: ToolConfig = {
  description:
    "Get the authenticated user's basic identity from the OAuth context (minimum scope: identity.basic, optionally identity.email/avatar/team). Returns curated identity. Retryable. No params.",
  parameters: { type: "object", properties: {} },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => (client as any).users.identity())
    if ((args as any).includeRaw) return result
    const curated: CuratedIdentity = {
      userId: (result as any).user?.id ?? null,
      name: (result as any).user?.name ?? null,
      email: (result as any).user?.email ?? null,
      teamId: (result as any).team?.id ?? null,
      teamName: (result as any).team?.name ?? null,
      teamDomain: (result as any).team?.domain ?? null,
      imageUrl:
        (result as any).user?.image_192 ??
        (result as any).user?.image_72 ??
        (result as any).user?.image_48 ??
        null,
    }
    return curated
  },
}
