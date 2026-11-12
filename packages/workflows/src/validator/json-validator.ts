/**
 * JSON Schema Validator
 *
 * Validates data against JSON Schemas using Zod, and against ArtifactSchemas
 * (the simplified property-based schema used in the Flowing model).
 *
 * Two validation modes:
 * 1. validateJsonSchema — validates against a full JSON Schema (draft-07 subset)
 * 2. validateArtifactSchema — validates against an ArtifactSchema (Flowing model)
 *
 * The ArtifactSchema is the Flowing model's schema format: a set of named
 * properties with types, required flags, and optional constraints (enum,
 * nested objects, array item types, strict mode).
 *
 * Supports a practical subset of JSON Schema draft-07:
 * - type: object, array, string, number, integer, boolean, null
 * - properties (for objects)
 * - required (for objects)
 * - items (for arrays)
 * - enum
 * - minimum, maximum (for numbers)
 * - minLength, maxLength (for strings)
 * - minItems, maxItems (for arrays)
 * - additionalProperties: false (strict object mode)
 */

import { z, type ZodType } from 'zod';

import type { ArtifactSchema, ArtifactProperty } from '../models/types';
import type { ValidationResult } from './types';

// ============================================================================
// ARTIFACT SCHEMA VALIDATION (form-first — User Forms unified types)
// ============================================================================

/**
 * Convert an ArtifactProperty (form-first field) to a Zod type.
 *
 * Handles the User Forms field types:
 * - text / textarea: z.string() with optional pattern
 * - number: z.number() with optional min/max
 * - select / radio: z.enum() from options (or z.string() if no options)
 * - checkbox: z.boolean()
 * - date / time / datetime: z.string() with optional min/max bounds
 *
 * Unknown types fall back to z.any() (non-blocking).
 */
function propertyTypeToZod(prop: ArtifactProperty): ZodType {
  const fieldType = prop.type;

  switch (fieldType) {
    case 'text':
    case 'textarea': {
      let zodStr = z.string();
      if (typeof prop.pattern === 'string' && prop.pattern.length > 0) {
        try {
          zodStr = zodStr.regex(new RegExp(prop.pattern));
        } catch {
          // Invalid pattern — skip it
        }
      }
      return zodStr;
    }

    case 'number': {
      let zodNum = z.number();
      if (typeof prop.min === 'number') {
        zodNum = zodNum.min(prop.min);
      }
      if (typeof prop.max === 'number') {
        zodNum = zodNum.max(prop.max);
      }
      return zodNum;
    }

    case 'select':
    case 'radio': {
      // Build enum from options
      if (prop.options && prop.options.length > 0) {
        const values = prop.options.map((o) => o.value);
        if (values.length === 1) {
          return z.literal(values[0]);
        }
        const literals = values.map((v) => z.literal(v));
        return z.union(literals as unknown as [ZodType, ZodType, ...ZodType[]]);
      }
      // No options defined — accept any string
      return z.string();
    }

    case 'checkbox':
      return z.boolean();

    case 'date':
    case 'time':
    case 'datetime': {
      // Date/time values travel as strings
      let zodStr = z.string();
      // min/max are ISO strings for date/datetime
      if (typeof prop.min === 'string' && prop.min.length > 0) {
        zodStr = zodStr.min(1); // Ensure non-empty; bounds checked separately
      }
      if (typeof prop.max === 'string' && prop.max.length > 0) {
        zodStr = zodStr.min(1);
      }
      return zodStr;
    }

    default:
      // Unknown type — accept anything rather than blocking
      return z.any();
  }
}

/**
 * Convert an ArtifactSchema to a Zod object schema.
 *
 * The ArtifactSchema defines a set of named properties with form-first
 * field types (FieldType) and required flags. This converts it to a Zod
 * object schema where required properties are mandatory and others are optional.
 *
 * Supports:
 * - All User Forms field types (text, textarea, number, select, checkbox, radio, date, time, datetime)
 * - Options for select/radio fields
 * - Min/max bounds for number and date/datetime fields
 * - Pattern validation for text/textarea fields
 * - Strict mode (via ArtifactSchema.strict)
 * - Array mode (via ArtifactSchema.isArray) — wraps the object schema in z.array()
 */
export function artifactSchemaToZod(schema: ArtifactSchema): ZodType {
  const objectSchema = artifactSchemaToObjectZod(schema);

  // Array mode: wrap the object schema in an array
  if (schema.isArray) {
    return z.array(objectSchema);
  }

  return objectSchema;
}

/**
 * Convert an ArtifactSchema to a Zod *object* schema (never wrapped in array).
 *
 * This is the core conversion logic, used both by artifactSchemaToZod (public)
 * and validateSingleObject (for validating individual array elements without
 * the array wrapper).
 */
function artifactSchemaToObjectZod(schema: ArtifactSchema): ZodType {
  if (schema.type !== 'object' || !schema.properties) {
    // Non-object schemas — accept anything
    return z.any();
  }

  const shape: Record<string, ZodType> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    const zodType = propertyTypeToZod(prop);
    if (prop.required) {
      shape[key] = zodType;
    } else {
      shape[key] = zodType.optional();
    }
  }

  const zodObj = z.object(shape);

  // Strict mode: reject extra properties
  if (schema.strict) {
    return zodObj.strict();
  }

  return zodObj;
}

/**
 * Validate data against an ArtifactSchema.
 *
 * Performs form-first validation:
 * 1. Converts the schema to a Zod object schema
 * 2. Validates the data against it (type checking, required fields, options, min/max, pattern)
 * 3. For date/datetime fields with min/max bounds, performs additional string comparison
 *
 * @param data - The data to validate
 * @param schema - The ArtifactSchema to validate against
 * @returns ValidationResult with `valid` and `errors`
 */
export function validateArtifactSchema(data: unknown, schema: ArtifactSchema): ValidationResult {
  if (!schema || typeof schema !== 'object') {
    return {
      valid: false,
      errors: ['Artifact schema must be a valid object'],
    };
  }

  // Non-object schemas accept anything
  if (schema.type !== 'object') {
    return { valid: true, errors: [] };
  }

  // Array mode: validate each element against the object schema
  if (schema.isArray) {
    if (!Array.isArray(data)) {
      return {
        valid: false,
        errors: [`Expected an array but got ${data === null ? 'null' : typeof data}`],
      };
    }

    // Validate each element individually for better error messages
    const allErrors: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const elementResult = validateSingleObject(data[i], schema);
      if (!elementResult.valid) {
        // Prefix errors with the array index
        for (const err of elementResult.errors) {
          allErrors.push(`[${i}]: ${err}`);
        }
      }
    }

    if (allErrors.length > 0) {
      return { valid: false, errors: allErrors };
    }

    return { valid: true, errors: [] };
  }

  // Single-object mode (default)
  return validateSingleObject(data, schema);
}

/**
 * Validate a single (non-array) object against an ArtifactSchema.
 *
 * This is the original validation logic, extracted so it can be reused
 * for each element in array mode.
 */
function validateSingleObject(data: unknown, schema: ArtifactSchema): ValidationResult {
  try {
    // Use the object schema (without array wrapper) so individual elements
    // validate correctly even when schema.isArray is true
    const zodSchema = artifactSchemaToObjectZod(schema);
    const result = zodSchema.safeParse(data);

    if (result.success) {
      // Additional validation for date/datetime min/max bounds (string comparison)
      const boundErrors = validateDateBounds(data, schema);
      if (boundErrors.length > 0) {
        return { valid: false, errors: boundErrors };
      }
      return { valid: true, errors: [] };
    }

    // Format Zod errors into human-readable messages
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });

    return { valid: false, errors };
  } catch (err) {
    return {
      valid: false,
      errors: [`Schema conversion failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Validate min/max bounds for date and datetime fields.
 *
 * Zod's .min() on strings checks string length, not date ordering.
 * This function performs proper ISO string comparison for date/datetime fields.
 */
function validateDateBounds(data: unknown, schema: ArtifactSchema): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type !== 'date' && prop.type !== 'datetime') continue;

    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') continue;

    if (typeof prop.min === 'string' && prop.min.length > 0 && value < prop.min) {
      errors.push(`${key}: value "${value}" is before minimum "${prop.min}"`);
    }
    if (typeof prop.max === 'string' && prop.max.length > 0 && value > prop.max) {
      errors.push(`${key}: value "${value}" is after maximum "${prop.max}"`);
    }
  }

  return errors;
}


// ============================================================================
// JSON SCHEMA → ZOD CONVERSION (legacy / advanced use)
// ============================================================================

/**
 * Convert a JSON Schema object to a Zod schema.
 *
 * @param schema - The JSON Schema as a plain object
 * @returns A ZodType that can be used to validate data
 * @throws Error if the schema is malformed or uses unsupported features
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): ZodType {
  return convertNode(schema);
}

/**
 * Recursively convert a JSON Schema node to a Zod type.
 */
function convertNode(node: Record<string, unknown>): ZodType {
  const type = node['type'];
  const enumValues = node['enum'];

  // Handle enum (takes precedence over type)
  if (Array.isArray(enumValues)) {
    const literals = enumValues.map((v) => {
      if (typeof v === 'string') return z.literal(v);
      if (typeof v === 'number') return z.literal(v);
      if (typeof v === 'boolean') return z.literal(v);
      if (v === null) return z.null();
      return z.literal(String(v));
    });

    if (literals.length === 1) {
      return literals[0];
    }
    return z.union(literals as unknown as [ZodType, ZodType, ...ZodType[]]);
  }

  // Handle $ref (simple internal refs not supported — treat as any)
  if (typeof node['$ref'] === 'string') {
    // @todo nira - 2026.08.31 : implement $ref resolution for internal schema references
    // once the schema registry pattern is established
    return z.any();
  }

  if (typeof type !== 'string') {
    // No type specified — accept anything (like z.any())
    // But check for composition keywords
    if (Array.isArray(node['allOf'])) {
      const subSchemas = node['allOf'] as Record<string, unknown>[];
      const zodSchemas = subSchemas.map(convertNode);
      if (zodSchemas.length === 0) return z.any();
      let result = zodSchemas[0];
      for (let i = 1; i < zodSchemas.length; i++) {
        result = result.and(zodSchemas[i]);
      }
      return result;
    }

    if (Array.isArray(node['anyOf'])) {
      const subSchemas = node['anyOf'] as Record<string, unknown>[];
      const zodSchemas = subSchemas.map(convertNode);
      if (zodSchemas.length === 0) return z.any();
      if (zodSchemas.length === 1) return zodSchemas[0];
      return z.union(zodSchemas as unknown as [ZodType, ZodType, ...ZodType[]]);
    }

    if (Array.isArray(node['oneOf'])) {
      const subSchemas = node['oneOf'] as Record<string, unknown>[];
      const zodSchemas = subSchemas.map(convertNode);
      if (zodSchemas.length === 0) return z.any();
      if (zodSchemas.length === 1) return zodSchemas[0];
      return z.union(zodSchemas as unknown as [ZodType, ZodType, ...ZodType[]]);
    }

    return z.any();
  }

  switch (type) {
    case 'object':
      return convertObject(node);
    case 'array':
      return convertArray(node);
    case 'string':
      return convertString(node);
    case 'number':
      return convertNumber(node);
    case 'integer':
      return convertInteger(node);
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      return z.any();
  }
}

/**
 * Convert a JSON Schema object type to Zod object schema.
 */
function convertObject(node: Record<string, unknown>): ZodType {
  const properties = node['properties'] as Record<string, Record<string, unknown>> | undefined;
  const required = node['required'] as string[] | undefined;
  const additionalProperties = node['additionalProperties'];

  if (!properties || Object.keys(properties).length === 0) {
    if (additionalProperties === false) {
      return z.object({}).strict();
    }
    return z.record(z.string(), z.any());
  }

  const shape: Record<string, ZodType> = {};
  const requiredSet = new Set(Array.isArray(required) ? required : []);

  for (const [key, propSchema] of Object.entries(properties)) {
    const zodType = convertNode(propSchema);
    if (requiredSet.has(key)) {
      shape[key] = zodType;
    } else {
      shape[key] = zodType.optional();
    }
  }

  const zodObj = z.object(shape);

  if (additionalProperties === false) {
    return zodObj.strict();
  }

  return zodObj;
}

/**
 * Convert a JSON Schema array type to Zod array schema.
 */
function convertArray(node: Record<string, unknown>): ZodType {
  const items = node['items'];
  const minItems = node['minItems'] as number | undefined;
  const maxItems = node['maxItems'] as number | undefined;

  let itemSchema: ZodType = z.any();
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    itemSchema = convertNode(items as Record<string, unknown>);
  }

  let zodArray = z.array(itemSchema);

  if (typeof minItems === 'number' && minItems > 0) {
    zodArray = zodArray.min(minItems);
  }
  if (typeof maxItems === 'number') {
    zodArray = zodArray.max(maxItems);
  }

  return zodArray;
}

/**
 * Convert a JSON Schema string type to Zod string schema.
 */
function convertString(node: Record<string, unknown>): ZodType {
  const minLength = node['minLength'] as number | undefined;
  const maxLength = node['maxLength'] as number | undefined;
  const pattern = node['pattern'] as string | undefined;

  let zodStr = z.string();

  if (typeof minLength === 'number' && minLength > 0) {
    zodStr = zodStr.min(minLength);
  }
  if (typeof maxLength === 'number') {
    zodStr = zodStr.max(maxLength);
  }
  if (typeof pattern === 'string') {
    try {
      zodStr = zodStr.regex(new RegExp(pattern));
    } catch {
      // Invalid pattern — skip it
    }
  }

  return zodStr;
}

/**
 * Convert a JSON Schema number type to Zod number schema.
 */
function convertNumber(node: Record<string, unknown>): ZodType {
  const minimum = node['minimum'] as number | undefined;
  const maximum = node['maximum'] as number | undefined;

  let zodNum = z.number();

  if (typeof minimum === 'number') {
    zodNum = zodNum.min(minimum);
  }
  if (typeof maximum === 'number') {
    zodNum = zodNum.max(maximum);
  }

  return zodNum;
}

/**
 * Convert a JSON Schema integer type to Zod number schema with int check.
 */
function convertInteger(node: Record<string, unknown>): ZodType {
  const minimum = node['minimum'] as number | undefined;
  const maximum = node['maximum'] as number | undefined;

  let zodInt = z.number().int();

  if (typeof minimum === 'number') {
    zodInt = zodInt.min(minimum);
  }
  if (typeof maximum === 'number') {
    zodInt = zodInt.max(maximum);
  }

  return zodInt;
}

// ============================================================================
// VALIDATION ENTRY POINT (legacy JSON Schema)
// ============================================================================

/**
 * Validate data against a JSON Schema.
 *
 * @param data - The data to validate (any JSON-compatible value)
 * @param schema - The JSON Schema as a plain object
 * @returns ValidationResult with `valid` and `errors`
 */
export function validateJsonSchema(data: unknown, schema: Record<string, unknown>): ValidationResult {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      valid: false,
      errors: ['Schema must be a JSON object'],
    };
  }

  try {
    const zodSchema = jsonSchemaToZod(schema);
    const result = zodSchema.safeParse(data);

    if (result.success) {
      return { valid: true, errors: [] };
    }

    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });

    return { valid: false, errors };
  } catch (err) {
    return {
      valid: false,
      errors: [`Schema conversion failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
