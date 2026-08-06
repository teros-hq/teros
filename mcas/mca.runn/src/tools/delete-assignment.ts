import type { ToolConfig } from "@teros/mca-sdk"
import { runnRequest } from "../lib"
import { validateId } from "./_runn-helpers"

export const deleteAssignment: ToolConfig = {
  description:
    "Delete a Runn assignment by id. Irreversible. Returns { success, assignmentId }. Params: assignmentId (required).",
  parameters: {
    type: "object",
    properties: {
      assignmentId: { type: "number", description: "Runn assignment id to delete." },
    },
    required: ["assignmentId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const { assignmentId } = args as { assignmentId: number }
    validateId(assignmentId, "assignmentId")

    await runnRequest(`/assignments/${assignmentId}`, context, { method: "DELETE" })
    return { success: true, assignmentId }
  },
}
