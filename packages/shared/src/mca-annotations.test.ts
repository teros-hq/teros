/**
 * MCA annotation schema tests.
 *
 * The name-based heuristic (inferToolAnnotations / resolveToolAnnotations,
 * Phase 2.7 — TER-348) was removed 2026-07-04: annotations are now always
 * explicit in each tool's ToolConfig, baked into every MCA source and
 * tools.json. What remains to validate is the schema contract itself —
 * especially the two Teros policy flags (`irreversible`, `alwaysAsk`) that
 * the permission gate and the renderer rely on.
 */

import { describe, expect, it } from 'bun:test';
import { McaToolAnnotationsSchema } from './mca-protocol';

describe('McaToolAnnotationsSchema', () => {
  it('accepts the full explicit shape', () => {
    const parsed = McaToolAnnotationsSchema.parse({
      version: '1.2.0',
      stability: 'stable',
      irreversible: true,
      alwaysAsk: true,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(parsed.alwaysAsk).toBe(true);
    expect(parsed.irreversible).toBe(true);
    expect(parsed.readOnlyHint).toBe(false);
  });

  it('accepts an empty object — every field is optional', () => {
    const parsed = McaToolAnnotationsSchema.parse({});
    expect(parsed.readOnlyHint).toBeUndefined();
    expect(parsed.alwaysAsk).toBeUndefined();
    expect(parsed.irreversible).toBeUndefined();
  });

  it('rejects truthy non-boolean policy flags (e.g. "true" as string)', () => {
    expect(() => McaToolAnnotationsSchema.parse({ alwaysAsk: 'true' })).toThrow();
    expect(() => McaToolAnnotationsSchema.parse({ irreversible: 'true' })).toThrow();
    expect(() => McaToolAnnotationsSchema.parse({ readOnlyHint: 1 })).toThrow();
  });

  it('rejects invalid stability values', () => {
    expect(() => McaToolAnnotationsSchema.parse({ stability: 'beta' })).toThrow();
  });
});
