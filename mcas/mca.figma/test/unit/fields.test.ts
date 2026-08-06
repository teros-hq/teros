import { describe, expect, it } from "bun:test"
import {
  COMMENT_FIELDS,
  COMPONENT_FIELDS,
  COMPONENT_SET_FIELDS,
  EXPORTED_IMAGE_FIELDS,
  FILE_FIELDS,
  NODE_FIELDS,
  STYLE_FIELDS,
  VARIABLE_COLLECTION_FIELDS,
  VARIABLE_FIELDS,
  VERSION_FIELDS,
} from "../../src/tools/_fields"

// Regression: the renderer falls back to placeholders when visual fields are
// missing from the whitelist. These asserts catch accidental narrowing by
// future edits.
describe("_fields whitelists", () => {
  it("FILE_FIELDS keeps identity + thumbnail + counts + document", () => {
    expect(FILE_FIELDS).toContain("name")
    expect(FILE_FIELDS).toContain("lastModified")
    expect(FILE_FIELDS).toContain("version")
    expect(FILE_FIELDS).toContain("thumbnailUrl")
    expect(FILE_FIELDS).toContain("document")
    expect(FILE_FIELDS).toContain("componentCount")
    expect(FILE_FIELDS).toContain("styleCount")
  })

  it("NODE_FIELDS keeps fills + bounds + textStyle (renderer paints swatches)", () => {
    expect(NODE_FIELDS).toContain("id")
    expect(NODE_FIELDS).toContain("name")
    expect(NODE_FIELDS).toContain("type")
    expect(NODE_FIELDS).toContain("fills")
    expect(NODE_FIELDS).toContain("bounds")
    expect(NODE_FIELDS).toContain("textStyle")
    expect(NODE_FIELDS).toContain("children")
  })

  it("COMPONENT_FIELDS keeps componentSetId so renderer shows variant badge", () => {
    expect(COMPONENT_FIELDS).toContain("id")
    expect(COMPONENT_FIELDS).toContain("key")
    expect(COMPONENT_FIELDS).toContain("name")
    expect(COMPONENT_FIELDS).toContain("description")
    expect(COMPONENT_FIELDS).toContain("componentSetId")
  })

  it("COMPONENT_SET_FIELDS keeps id + key + name + description", () => {
    expect(COMPONENT_SET_FIELDS).toContain("id")
    expect(COMPONENT_SET_FIELDS).toContain("key")
    expect(COMPONENT_SET_FIELDS).toContain("name")
    expect(COMPONENT_SET_FIELDS).toContain("description")
  })

  it("STYLE_FIELDS keeps type so renderer maps FILL/TEXT/EFFECT to a colour", () => {
    expect(STYLE_FIELDS).toContain("id")
    expect(STYLE_FIELDS).toContain("key")
    expect(STYLE_FIELDS).toContain("name")
    expect(STYLE_FIELDS).toContain("type")
    expect(STYLE_FIELDS).toContain("description")
  })

  it("VARIABLE_FIELDS keeps values (the actual token data)", () => {
    expect(VARIABLE_FIELDS).toContain("id")
    expect(VARIABLE_FIELDS).toContain("name")
    expect(VARIABLE_FIELDS).toContain("type")
    expect(VARIABLE_FIELDS).toContain("values")
  })

  it("VARIABLE_COLLECTION_FIELDS keeps modes + variables + defaultModeId", () => {
    expect(VARIABLE_COLLECTION_FIELDS).toContain("id")
    expect(VARIABLE_COLLECTION_FIELDS).toContain("name")
    expect(VARIABLE_COLLECTION_FIELDS).toContain("modes")
    expect(VARIABLE_COLLECTION_FIELDS).toContain("variables")
    expect(VARIABLE_COLLECTION_FIELDS).toContain("defaultModeId")
  })

  it("COMMENT_FIELDS exposes parentId (replies) and resolved", () => {
    expect(COMMENT_FIELDS).toContain("id")
    expect(COMMENT_FIELDS).toContain("message")
    expect(COMMENT_FIELDS).toContain("createdAt")
    expect(COMMENT_FIELDS).toContain("user")
    expect(COMMENT_FIELDS).toContain("resolved")
    expect(COMMENT_FIELDS).toContain("parentId")
  })

  it("VERSION_FIELDS keeps user + label + createdAt for the renderer", () => {
    expect(VERSION_FIELDS).toContain("id")
    expect(VERSION_FIELDS).toContain("createdAt")
    expect(VERSION_FIELDS).toContain("label")
    expect(VERSION_FIELDS).toContain("user")
  })

  it("EXPORTED_IMAGE_FIELDS keeps url + format + scale (the renderer needs all three)", () => {
    expect(EXPORTED_IMAGE_FIELDS).toContain("nodeId")
    expect(EXPORTED_IMAGE_FIELDS).toContain("url")
    expect(EXPORTED_IMAGE_FIELDS).toContain("format")
    expect(EXPORTED_IMAGE_FIELDS).toContain("scale")
  })
})
