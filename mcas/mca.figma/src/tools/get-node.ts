import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { NODE_FIELDS } from "./_fields"
import { type FigmaNode, simplifyNode } from "./_helpers"
import { normalizeNodeId, resolveFields, sanitizeNumber, validateFileKey } from "./utils"

interface NodesResponse {
  nodes: Record<string, { document: FigmaNode } | null>
}

export const getNode: ToolConfig = {
  description:
    'Get a single node from a Figma file as a curated tree. Returns the node directly (not wrapped). Use this to drill into a frame/component beyond the depth returned by get-file. Params: fileKey, nodeId (accepts "1-2" or "1:2"), depth (1-10, def 3), fields?, includeRaw.',
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      nodeId: {
        type: "string",
        description: 'Node ID. Accepts the URL format "1-2" or REST format "1:2".',
      },
      depth: {
        type: "number",
        description: "How deep to traverse children. Min 1, max 10, default 3.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default node whitelist.",
      },
      includeRaw: { type: "boolean", description: "Return raw upstream node. Default false." },
    },
    required: ["fileKey", "nodeId"],
  },
  annotations: { readOnlyHint: true, version: "2.1.0", stability: "stable" },
  handler: async (args, context) => {
    const { fileKey, nodeId, depth, fields, includeRaw } = args as {
      fileKey: string
      nodeId: string
      depth?: number
      fields?: string[]
      includeRaw?: boolean
    }

    const safeKey = validateFileKey(fileKey)
    const safeNodeId = normalizeNodeId(nodeId)
    const safeDepth = sanitizeNumber(depth, { min: 1, max: 10, default: 3, integer: true })

    const response = await figmaRequest<NodesResponse>(
      `/files/${safeKey}/nodes?ids=${encodeURIComponent(safeNodeId)}&depth=${safeDepth}`,
      context,
    )

    const nodeData = response.nodes[safeNodeId]
    if (!nodeData) {
      throw new Error(`Node ${nodeId} not found in file ${fileKey}`)
    }

    const shaped = simplifyNode(nodeData.document, safeDepth)
    return resolveFields(shaped as any, nodeData.document, {
      includeRaw,
      fields,
      defaultFields: NODE_FIELDS,
    })
  },
}
