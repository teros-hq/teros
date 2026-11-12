/**
 * The adapter is the source seam. Today the approval path's metadata comes from
 * the backend reading tools.json; under @agentapps/protocol it arrives as a
 * ToolDefinition over a session-plane tools_list. These tests pin the protocol
 * shape so that swap touches one function.
 */

import { describe, expect, test } from "bun:test"
import {
  type AgentAppsToolDefinition,
  toolDetailFromDefinition,
} from "../../../../packages/app/src/components/mca/tool-definition-adapter"

const definition: AgentAppsToolDefinition = {
  name: "share-file",
  description: "Share a file with a user",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "The file to share" },
      email: { type: "string" },
    },
    required: ["fileId"],
  },
  annotations: { destructiveHint: false, summary: "Shares a Drive file" },
}

describe("toolDetailFromDefinition", () => {
  test("maps a protocol-shaped definition onto ToolDetail", () => {
    const detail = toolDetailFromDefinition("mydrive_share-file", definition)

    expect(detail.requestedName).toBe("mydrive_share-file")
    expect(detail.name).toBe("share-file")
    expect(detail.description).toBe("Share a file with a user")
    expect(detail.parameters.required).toEqual(["fileId"])
    expect(detail.annotations?.summary).toBe("Shares a Drive file")
  })

  test("omits annotations entirely when the definition has none", () => {
    const { annotations: _dropped, ...bare } = definition
    const detail = toolDetailFromDefinition("mydrive_share-file", bare)

    expect("annotations" in detail).toBe(false)
  })

  test("preserves a schema with no properties", () => {
    const detail = toolDetailFromDefinition("app_ping", {
      name: "ping",
      description: "Ping",
      parameters: { type: "object", properties: {} },
    })

    expect(detail.parameters.properties).toEqual({})
  })

  test("throws when requestedName is empty", () => {
    expect(() => toolDetailFromDefinition("", definition)).toThrow(
      /toolDetailFromDefinition: requestedName is required/,
    )
  })

  test("throws when the definition has no name", () => {
    const nameless = { ...definition, name: "" }
    expect(() => toolDetailFromDefinition("mydrive_share-file", nameless)).toThrow(
      /toolDetailFromDefinition: definition\.name is required/,
    )
  })

  test("throws when parameters.properties is absent", () => {
    const broken = {
      ...definition,
      parameters: { type: "object" } as AgentAppsToolDefinition["parameters"],
    }
    expect(() => toolDetailFromDefinition("mydrive_share-file", broken)).toThrow(
      /toolDetailFromDefinition: definition\.parameters\.properties is required/,
    )
  })

  test("throws when parameters.properties is null", () => {
    const broken = {
      ...definition,
      parameters: {
        type: "object",
        properties: null,
      } as unknown as AgentAppsToolDefinition["parameters"],
    }
    expect(() => toolDetailFromDefinition("mydrive_share-file", broken)).toThrow(
      /toolDetailFromDefinition: definition\.parameters\.properties is required/,
    )
  })
})
