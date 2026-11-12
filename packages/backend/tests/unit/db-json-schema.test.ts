/**
 * zod → $jsonSchema converter (GOV-2): the document schemas in
 * src/db/schemas.ts are the single source of truth and the validators that
 * migration 20261017_011 installs are generated from them.
 *
 * The fixture is the hand-written $jsonSchema the migration applied before the
 * schemas moved to zod; the generated one must stay equal to it unless a
 * schema change is intended (then update the fixture in the same commit).
 */

import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { toJsonSchema } from "../../src/db/json-schema"
import { COLLECTION_SCHEMAS, DOC_SCHEMAS } from "../../src/db/schemas"
import before from "./_jsonschema-validators-20261017.json"

describe("toJsonSchema", () => {
  it("maps scalars", () => {
    expect(toJsonSchema(z.string())).toEqual({ bsonType: "string" })
    expect(toJsonSchema(z.number())).toEqual({ bsonType: "number" })
    expect(toJsonSchema(z.boolean())).toEqual({ bsonType: "bool" })
    expect(toJsonSchema(z.date())).toEqual({ bsonType: "date" })
  })

  it("maps enums, nullable, unions and arrays", () => {
    expect(toJsonSchema(z.enum(["a", "b"]))).toEqual({ enum: ["a", "b"] })
    expect(toJsonSchema(z.enum(["a"]).nullable())).toEqual({ enum: ["a", null] })
    expect(toJsonSchema(z.string().nullable())).toEqual({ bsonType: ["string", "null"] })
    expect(toJsonSchema(z.union([z.date(), z.string()]))).toEqual({ bsonType: ["date", "string"] })
    expect(toJsonSchema(z.union([z.string(), z.enum(["x"])]))).toEqual({
      anyOf: [{ bsonType: "string" }, { enum: ["x"] }],
    })
    expect(toJsonSchema(z.array(z.string()))).toEqual({ bsonType: "array", items: { bsonType: "string" } })
  })

  it("maps objects: required = non-optional keys, passthrough/strict, empty shape", () => {
    const schema = z
      .object({
        a: z.string(),
        b: z.number().optional(),
        nested: z.object({ c: z.boolean() }).strict(),
        loose: z.object({}).passthrough().optional(),
      })
      .passthrough()
    expect(toJsonSchema(schema)).toEqual({
      bsonType: "object",
      additionalProperties: true,
      required: ["a", "nested"],
      properties: {
        a: { bsonType: "string" },
        b: { bsonType: "number" },
        nested: {
          bsonType: "object",
          additionalProperties: false,
          required: ["c"],
          properties: { c: { bsonType: "bool" } },
        },
        loose: { bsonType: "object" },
      },
    })
  })

  it("throws on types it cannot mirror", () => {
    expect(() => toJsonSchema(z.record(z.string()))).toThrow("unsupported")
  })
})

describe("generated validators (migration 20261017_011)", () => {
  it("equal the hand-written $jsonSchema the migration applied before", () => {
    expect(COLLECTION_SCHEMAS).toEqual(before)
    // Same collections, same order as the migration applies them
    expect(Object.keys(COLLECTION_SCHEMAS)).toEqual(Object.keys(before))
  })

  it("every document schema is passthrough (extra fields are never a violation)", () => {
    for (const schema of Object.values(DOC_SCHEMAS)) {
      expect(schema._def.unknownKeys).toBe("passthrough")
    }
  })
})
