/**
 * Tests for the Gate Validator — Artifact schema validation, text template validation,
 * and JSON Schema validation.
 *
 * These tests verify:
 * 1. Artifact schema validation: property types, required fields
 * 2. Gate-level validation: signal-only gates, artifact-referencing gates
 * 3. Multi-gate validation (validateGates with schemaMap)
 * 4. Text template validation: placeholder extraction, matching, variable capture
 * 5. JSON Schema validation (legacy): type checking, required fields, constraints
 */

import { describe, expect, it } from 'bun:test';

import {
  validateGate,
  validateGates,
  validateArtifactSchema,
  artifactSchemaToZod,
  validateTextTemplate,
  validateJsonSchema,
  jsonSchemaToZod,
  extractTemplateVariables,
  type Gate,
  type ArtifactSchema,
  type ValidationResult,
  type FieldType,
  type FieldOption,
} from '../src/validator/index';

import { generateGateId } from '../src/models/index';

// ============================================================================
// HELPER — create gates and schemas
// ============================================================================

function makeSignalGate(gateId?: string): Gate {
  return { gateId: gateId ?? generateGateId(), schemaId: null };
}

function makeArtifactGate(schemaId: string, label?: string, mode?: 'passthrough' | 'find' | 'create'): Gate {
  return { gateId: generateGateId(), schemaId, label, mode };
}

function makeArtifactSchema(name: string, properties: Record<string, { type: FieldType; required?: boolean; options?: FieldOption[]; min?: number | string; max?: number | string; pattern?: string }>): ArtifactSchema {
  const props: Record<string, any> = {};
  for (const [key, val] of Object.entries(properties)) {
    props[key] = { name: key, type: val.type, required: val.required };
    if (val.options) props[key].options = val.options;
    if (val.min !== undefined) props[key].min = val.min;
    if (val.max !== undefined) props[key].max = val.max;
    if (val.pattern) props[key].pattern = val.pattern;
  }
  return { name, title: name, type: 'object', properties: props };
}

// ============================================================================
// ARTIFACT SCHEMA VALIDATION
// ============================================================================

describe('validateArtifactSchema', () => {
  it('validates an object with required fields present', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });
    const result = validateArtifactSchema({ name: 'John', email: 'john@example.com' }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required field is missing', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });
    const result = validateArtifactSchema({ name: 'John' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes when optional field is absent', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      company: { type: 'text' },
    });
    const result = validateArtifactSchema({ name: 'John' }, schema);
    expect(result.valid).toBe(true);
  });

  it('validates number type', () => {
    const schema = makeArtifactSchema('Score', {
      score: { type: 'number', required: true },
    });
    expect(validateArtifactSchema({ score: 42 }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ score: '42' }, schema).valid).toBe(false);
  });

  it('validates boolean type', () => {
    const schema = makeArtifactSchema('Flag', {
      active: { type: 'checkbox', required: true },
    });
    expect(validateArtifactSchema({ active: true }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ active: 'true' }, schema).valid).toBe(false);
  });

  it('handles non-object schema type (accepts anything)', () => {
    const schema: ArtifactSchema = {
      name: 'Text',
      title: 'Text',
      type: 'string',
      properties: {},
    };
    expect(validateArtifactSchema('anything', schema).valid).toBe(true);
  });
});

// ============================================================================
// ARTIFACT SCHEMA → ZOD CONVERSION
// ============================================================================

describe('artifactSchemaToZod', () => {
  it('converts artifact schema to Zod object schema', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: 'test' }).success).toBe(true);
    expect(zodSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// GATE-LEVEL VALIDATION (validateGate)
// ============================================================================

describe('validateGate', () => {
  it('signal-only gate (schemaId null) always passes', () => {
    const gate = makeSignalGate();
    expect(validateGate(gate, undefined).valid).toBe(true);
    expect(validateGate(gate, null).valid).toBe(true);
    expect(validateGate(gate, { any: 'data' }).valid).toBe(true);
  });

  it('artifact gate with valid data passes', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead', 'Lead Input', 'passthrough');
    const result = validateGate(gate, { name: 'John' }, schema);
    expect(result.valid).toBe(true);
  });

  it('artifact gate with invalid data fails', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead', 'Lead Input');
    const result = validateGate(gate, { wrongField: 'data' }, schema);
    expect(result.valid).toBe(false);
  });

  it('artifact gate with null data fails', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead', 'Lead Input');
    const result = validateGate(gate, null, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('null');
  });

  it('artifact gate without resolved schema fails', () => {
    const gate = makeArtifactGate('art_lead', 'Lead Input');
    const result = validateGate(gate, { name: 'John' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('no schema was resolved');
  });
});

// ============================================================================
// MULTI-GATE VALIDATION (validateGates)
// ============================================================================

describe('validateGates', () => {
  it('validates multiple gates when all pass', () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const reportSchema = makeArtifactSchema('Report', {
      title: { type: 'text', required: true },
    });

    const gates = [
      makeArtifactGate('art_lead', 'Lead'),
      makeArtifactGate('art_report', 'Report'),
    ];

    const schemaMap = new Map<string, ArtifactSchema>([
      ['art_lead', leadSchema],
      ['art_report', reportSchema],
    ]);

    const dataMap = {
      [gates[0].gateId]: { name: 'John' },
      [gates[1].gateId]: { title: 'Report Title' },
    };

    const result = validateGates(gates, dataMap, schemaMap);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when one gate fails', () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });

    const gates = [
      makeArtifactGate('art_lead', 'Lead'),
      makeSignalGate('g_signal'),
    ];

    const schemaMap = new Map<string, ArtifactSchema>([
      ['art_lead', leadSchema],
    ]);

    const dataMap = {
      [gates[0].gateId]: { wrongField: 'data' },
      [gates[1].gateId]: undefined,
    };

    const result = validateGates(gates, dataMap, schemaMap);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes with empty gates array', () => {
    expect(validateGates([], {}).valid).toBe(true);
  });

  it('passes with signal-only gates and no schemaMap', () => {
    const gates = [makeSignalGate('g1'), makeSignalGate('g2')];
    const result = validateGates(gates, {}, null);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// TEXT TEMPLATE VALIDATION (kept for instruction interpolation)
// ============================================================================

describe('extractTemplateVariables', () => {
  it('extracts a single variable', () => {
    expect(extractTemplateVariables('Hello {{name}}')).toEqual(['name']);
  });

  it('extracts multiple variables in order', () => {
    expect(extractTemplateVariables('{{topic}}: {{content}} by {{author}}')).toEqual([
      'topic', 'content', 'author',
    ]);
  });

  it('deduplicates variables', () => {
    expect(extractTemplateVariables('{{x}} and {{x}} again')).toEqual(['x']);
  });

  it('returns empty array for no placeholders', () => {
    expect(extractTemplateVariables('Just plain text')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractTemplateVariables('')).toEqual([]);
  });
});

describe('validateTextTemplate', () => {
  it('validates text with a single variable', () => {
    const result = validateTextTemplate('Summary of AI trends', 'Summary of {{topic}}');
    expect(result.valid).toBe(true);
    expect(result.variables).toEqual({ topic: 'AI trends' });
  });

  it('fails when data is not a string', () => {
    const result = validateTextTemplate(42, '{{value}}');
    expect(result.valid).toBe(false);
  });

  it('fails when data does not match template pattern', () => {
    const result = validateTextTemplate('Completely different text', 'Summary of {{topic}}');
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// JSON SCHEMA VALIDATION (legacy)
// ============================================================================

describe('validateJsonSchema', () => {
  it('validates a simple object with required field', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    expect(validateJsonSchema({ title: 'Report' }, schema).valid).toBe(true);
    expect(validateJsonSchema({ description: 'no title' }, schema).valid).toBe(false);
  });

  it('validates array of strings', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    expect(validateJsonSchema(['a', 'b', 'c'], schema).valid).toBe(true);
    expect(validateJsonSchema(['a', 42, 'c'], schema).valid).toBe(false);
  });

  it('validates string type', () => {
    expect(validateJsonSchema('hello', { type: 'string' }).valid).toBe(true);
    expect(validateJsonSchema(42, { type: 'string' }).valid).toBe(false);
  });

  it('validates number type', () => {
    expect(validateJsonSchema(42, { type: 'number' }).valid).toBe(true);
    expect(validateJsonSchema('42', { type: 'number' }).valid).toBe(false);
  });

  it('validates enum', () => {
    const schema = { enum: ['draft', 'active', 'archived'] };
    expect(validateJsonSchema('active', schema).valid).toBe(true);
    expect(validateJsonSchema('invalid', schema).valid).toBe(false);
  });

  it('fails when schema is not an object', () => {
    expect(validateJsonSchema('data', 'not-an-object').valid).toBe(false);
    expect(validateJsonSchema('data', null).valid).toBe(false);
  });
});

describe('jsonSchemaToZod', () => {
  it('converts a simple object schema to Zod', () => {
    const zodSchema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(zodSchema.safeParse({ name: 'test' }).success).toBe(true);
    expect(zodSchema.safeParse({}).success).toBe(false);
  });
});
// ============================================================================
// ENHANCED ARTIFACT SCHEMA TESTS (R2 — form-first features: options, min/max, pattern, strict)
// ============================================================================

describe('validateArtifactSchema — enhanced features (R2)', () => {
  it('validates select field with options', () => {
    const schema = makeArtifactSchema('Task', {
      status: { type: 'select', required: true, options: [
        { value: 'draft', label: 'Draft' },
        { value: 'active', label: 'Active' },
        { value: 'archived', label: 'Archived' },
      ] },
    });

    expect(validateArtifactSchema({ status: 'active' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ status: 'draft' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ status: 'invalid' }, schema).valid).toBe(false);
  });


  it('validates textarea field (accepts any string)', () => {
    const schema = makeArtifactSchema('Note', {
      body: { type: 'textarea', required: true },
    });

    expect(validateArtifactSchema({ body: 'Hello world' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ body: '' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ body: 42 }, schema).valid).toBe(false);
  });

  it('validates radio field with options', () => {
    const schema = makeArtifactSchema('Priority', {
      level: { type: 'radio', required: true, options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ] },
    });

    expect(validateArtifactSchema({ level: 'low' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ level: 'high' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ level: 'invalid' }, schema).valid).toBe(false);
  });

  it('validates text field with pattern (email)', () => {
    const schema = makeArtifactSchema('Contact', {
      email: { type: 'text', required: true, pattern: '^[^@]+@[^@]+\\.[^@]+$' },
    });

    expect(validateArtifactSchema({ email: 'john@example.com' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ email: 'not-an-email' }, schema).valid).toBe(false);
  });

  it('validates date field with min/max bounds', () => {
    const schema = makeArtifactSchema('Event', {
      date: { type: 'date', required: true, min: '2026-01-01', max: '2026-12-31' },
    });

    expect(validateArtifactSchema({ date: '2026-06-15' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ date: '2025-01-01' }, schema).valid).toBe(false);
    expect(validateArtifactSchema({ date: '2027-01-01' }, schema).valid).toBe(false);
  });

  it('strict mode rejects extra properties at top level', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.strict = true;

    expect(validateArtifactSchema({ name: 'John' }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ name: 'John', extra: 'field' }, schema).valid).toBe(false);
  });

  it('validates checkbox field (boolean)', () => {
    const schema = makeArtifactSchema('Settings', {
      enabled: { type: 'checkbox', required: true },
    });

    expect(validateArtifactSchema({ enabled: true }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ enabled: false }, schema).valid).toBe(true);
    expect(validateArtifactSchema({ enabled: 'yes' }, schema).valid).toBe(false);
  });

  it('non-strict mode allows extra properties', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    // strict not set — defaults to false

    expect(validateArtifactSchema({ name: 'John', extra: 'field' }, schema).valid).toBe(true);
  });
});

// ============================================================================
// ENHANCED GATE VALIDATION TESTS (R2 — error messages with gate context)
// ============================================================================

describe('validateGate — enhanced error messages (R2)', () => {
  it('error messages include gate label and artifact name', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead', 'Lead Input', 'passthrough');
    const result = validateGate(gate, { wrongField: 'data' }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Lead Input');
    expect(result.errors[0]).toContain('Lead');
  });

  it('error messages use gateId when no label is set', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead');
    // No label set
    gate.label = undefined;
    const result = validateGate(gate, { wrongField: 'data' }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain(gate.gateId);
  });

  it('null data error includes artifact name', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const gate = makeArtifactGate('art_lead', 'Lead Input');
    const result = validateGate(gate, null, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Lead');
    expect(result.errors[0]).toContain('null');
  });

  it('unresolved schema error includes schemaId', () => {
    const gate = makeArtifactGate('art_lead', 'Lead Input');
    const result = validateGate(gate, { name: 'John' });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('art_lead');
    expect(result.errors[0]).toContain('no schema was resolved');
  });
});

// ============================================================================
// ARTIFACT SCHEMA → ZOD CONVERSION — enhanced features
// ============================================================================

describe('artifactSchemaToZod — enhanced features (R2)', () => {
  it('converts select field with options to Zod', () => {
    const schema = makeArtifactSchema('Task', {
      status: { type: 'select', required: true, options: [
        { value: 'draft', label: 'Draft' },
        { value: 'active', label: 'Active' },
      ] },
    });

    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse({ status: 'draft' }).success).toBe(true);
    expect(zodSchema.safeParse({ status: 'invalid' }).success).toBe(false);
  });


  it('converts strict mode to Zod .strict()', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.strict = true;

    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: 'test' }).success).toBe(true);
    expect(zodSchema.safeParse({ name: 'test', extra: 'field' }).success).toBe(false);
  });

  it('converts date field to Zod string', () => {
    const schema = makeArtifactSchema('Event', {
      date: { type: 'date', required: true },
    });

    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse({ date: '2026-06-15' }).success).toBe(true);
    expect(zodSchema.safeParse({ date: 42 }).success).toBe(false);
  });
});

// ============================================================================
// ARRAY MODE TESTS (Split/Join Phase 1 — isArray flag on ArtifactSchema)
// ============================================================================

describe('validateArtifactSchema — array mode (isArray)', () => {
  it('validates an array of valid objects', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });
    schema.isArray = true;

    const data = [
      { name: 'John', email: 'john@example.com' },
      { name: 'Jane', email: 'jane@example.com' },
    ];
    const result = validateArtifactSchema(data, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates a single-element array', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const result = validateArtifactSchema([{ name: 'John' }], schema);
    expect(result.valid).toBe(true);
  });

  it('validates an empty array (no elements = no errors)', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const result = validateArtifactSchema([], schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when data is not an array (object instead)', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const result = validateArtifactSchema({ name: 'John' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected an array');
    expect(result.errors[0]).toContain('object');
  });

  it('fails when data is null', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const result = validateArtifactSchema(null, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected an array');
    expect(result.errors[0]).toContain('null');
  });

  it('fails when a required field is missing in one element', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });
    schema.isArray = true;

    const data = [
      { name: 'John', email: 'john@example.com' },
      { name: 'Jane' }, // missing email
    ];
    const result = validateArtifactSchema(data, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('prefixes errors with array index for better debugging', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const data = [
      { name: 'John' },
      {}, // missing name at index 1
    ];
    const result = validateArtifactSchema(data, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.startsWith('[1]:'))).toBe(true);
  });

  it('collects errors from multiple invalid elements', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const data = [
      {}, // missing name at index 0
      { name: 'Jane' },
      {}, // missing name at index 2
    ];
    const result = validateArtifactSchema(data, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.startsWith('[0]:'))).toBe(true);
    expect(result.errors.some(e => e.startsWith('[2]:'))).toBe(true);
  });

  it('validates array with number type fields', () => {
    const schema = makeArtifactSchema('Score', {
      score: { type: 'number', required: true },
    });
    schema.isArray = true;

    expect(validateArtifactSchema([{ score: 42 }, { score: 100 }], schema).valid).toBe(true);
    expect(validateArtifactSchema([{ score: 42 }, { score: '100' }], schema).valid).toBe(false);
  });

  it('validates array with select options', () => {
    const schema = makeArtifactSchema('Task', {
      status: { type: 'select', required: true, options: [
        { value: 'draft', label: 'Draft' },
        { value: 'active', label: 'Active' },
      ] },
    });
    schema.isArray = true;

    expect(validateArtifactSchema([{ status: 'draft' }, { status: 'active' }], schema).valid).toBe(true);
    expect(validateArtifactSchema([{ status: 'draft' }, { status: 'invalid' }], schema).valid).toBe(false);
  });

  it('validates array with strict mode (rejects extra properties per element)', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.strict = true;
    schema.isArray = true;

    expect(validateArtifactSchema([{ name: 'John' }], schema).valid).toBe(true);
    expect(validateArtifactSchema([{ name: 'John', extra: 'field' }], schema).valid).toBe(false);
  });

  it('validates array with date bounds per element', () => {
    const schema = makeArtifactSchema('Event', {
      date: { type: 'date', required: true, min: '2026-01-01', max: '2026-12-31' },
    });
    schema.isArray = true;

    expect(validateArtifactSchema([{ date: '2026-06-15' }, { date: '2026-03-01' }], schema).valid).toBe(true);
    expect(validateArtifactSchema([{ date: '2026-06-15' }, { date: '2025-01-01' }], schema).valid).toBe(false);
  });

  it('validates array with optional fields absent', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      company: { type: 'text' }, // optional
    });
    schema.isArray = true;

    const data = [
      { name: 'John', company: 'Acme' },
      { name: 'Jane' }, // company absent — OK
    ];
    expect(validateArtifactSchema(data, schema).valid).toBe(true);
  });
});

// ============================================================================
// ARTIFACT SCHEMA → ZOD CONVERSION — array mode
// ============================================================================

describe('artifactSchemaToZod — array mode (isArray)', () => {
  it('returns z.array() when isArray is true', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const zodSchema = artifactSchemaToZod(schema);
    // Array schema should accept arrays
    expect(zodSchema.safeParse([{ name: 'John' }]).success).toBe(true);
    // Array schema should reject single objects
    expect(zodSchema.safeParse({ name: 'John' }).success).toBe(false);
  });

  it('returns object schema (not array) when isArray is false/undefined', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    // isArray not set — defaults to false

    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: 'John' }).success).toBe(true);
    expect(zodSchema.safeParse([{ name: 'John' }]).success).toBe(false);
  });

  it('array mode + strict mode rejects extra properties in each element', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.strict = true;
    schema.isArray = true;

    const zodSchema = artifactSchemaToZod(schema);
    expect(zodSchema.safeParse([{ name: 'John' }]).success).toBe(true);
    expect(zodSchema.safeParse([{ name: 'John', extra: 'field' }]).success).toBe(false);
  });
});

// ============================================================================
// GATE-LEVEL VALIDATION — array mode (validateGate with isArray schema)
// ============================================================================

describe('validateGate — array mode (isArray)', () => {
  it('validates array data through a gate with isArray schema', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const gate = makeArtifactGate('art_lead', 'Leads Input');
    const result = validateGate(gate, [{ name: 'John' }, { name: 'Jane' }], schema);
    expect(result.valid).toBe(true);
  });

  it('fails gate validation when array element is invalid', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const gate = makeArtifactGate('art_lead', 'Leads Input');
    const result = validateGate(gate, [{ name: 'John' }, {}], schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Leads Input');
  });

  it('fails gate validation when non-array data is passed to isArray schema', () => {
    const schema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    schema.isArray = true;

    const gate = makeArtifactGate('art_lead', 'Leads Input');
    const result = validateGate(gate, { name: 'John' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected an array');
  });
});
