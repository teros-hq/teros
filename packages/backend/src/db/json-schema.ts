/**
 * zod → MongoDB `$jsonSchema` for the subset the document schemas use
 * (./schemas.ts): object, string, number, boolean, date, enum, optional,
 * nullable, union, array. Anything else throws, so a schema that cannot be
 * mirrored in mongod is caught at import time instead of silently drifting.
 *
 * Mapping:
 *   z.object(shape)       → { bsonType: 'object', additionalProperties, required, properties }
 *                           (an empty shape is just { bsonType: 'object' };
 *                           passthrough → additionalProperties true, strict → false)
 *   z.string/number/boolean/date → bsonType 'string' | 'number' | 'bool' | 'date'
 *   z.enum([...])         → { enum: [...] }
 *   .optional()           → key left out of `required`
 *   .nullable()           → adds 'null' to bsonType (or null to the enum)
 *   z.union([...])        → merged bsonType list when every member is a plain
 *                           bsonType, otherwise anyOf
 *   z.array(item)         → { bsonType: 'array', items }
 */

import type { Document } from 'mongodb'
import { z } from 'zod'

const SCALARS: Partial<Record<z.ZodFirstPartyTypeKind, string>> = {
  [z.ZodFirstPartyTypeKind.ZodString]: 'string',
  [z.ZodFirstPartyTypeKind.ZodNumber]: 'number', // $jsonSchema alias for double | int | long | decimal
  [z.ZodFirstPartyTypeKind.ZodBoolean]: 'bool',
  [z.ZodFirstPartyTypeKind.ZodDate]: 'date',
}

function isPlainBsonType(s: Document): s is { bsonType: string | string[] } {
  return Object.keys(s).length === 1 && 'bsonType' in s
}

function withNull(s: Document): Document {
  if (Array.isArray(s.enum)) return { ...s, enum: [...s.enum, null] }
  if (s.bsonType !== undefined) {
    const types = Array.isArray(s.bsonType) ? s.bsonType : [s.bsonType]
    return { ...s, bsonType: [...types, 'null'] }
  }
  return { anyOf: [s, { bsonType: 'null' }] }
}

export function toJsonSchema(schema: z.ZodTypeAny): Document {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind }
  const scalar = SCALARS[def.typeName]
  if (scalar) return { bsonType: scalar }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const keys = Object.keys(shape)
    if (keys.length === 0) return { bsonType: 'object' }
    const out: Document = { bsonType: 'object' }
    const unknownKeys = schema._def.unknownKeys as string
    if (unknownKeys === 'passthrough') out.additionalProperties = true
    else if (unknownKeys === 'strict') out.additionalProperties = false
    const required = keys.filter((k) => !shape[k].isOptional())
    if (required.length > 0) out.required = required
    out.properties = Object.fromEntries(keys.map((k) => [k, toJsonSchema(shape[k])]))
    return out
  }
  if (schema instanceof z.ZodEnum) return { enum: [...(schema.options as string[])] }
  if (schema instanceof z.ZodOptional) return toJsonSchema(schema.unwrap())
  if (schema instanceof z.ZodNullable) return withNull(toJsonSchema(schema.unwrap()))
  if (schema instanceof z.ZodArray) return { bsonType: 'array', items: toJsonSchema(schema.element) }
  if (schema instanceof z.ZodUnion) {
    const members = (schema.options as z.ZodTypeAny[]).map(toJsonSchema)
    if (members.every(isPlainBsonType)) {
      const types = members.flatMap((m) => (Array.isArray(m.bsonType) ? m.bsonType : [m.bsonType]))
      return { bsonType: [...new Set(types)] }
    }
    return { anyOf: members }
  }
  throw new Error(`toJsonSchema: unsupported zod type ${def.typeName}`)
}
