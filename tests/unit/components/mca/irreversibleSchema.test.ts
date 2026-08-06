/**
 * Tests for the irreversible flag schema validation (B2 of post-review).
 *
 * Pin the contract that `McaToolAnnotationsSchema` rejects malformed
 * inputs. The end-to-end chain (executor → permission-manager →
 * frontend) only carries `irreversible` because:
 *   1. The schema validates booleans strictly.
 *   2. Manifests with non-boolean values are rejected at load time
 *      (`loadStaticTools` in mca-manager.tools.ts).
 *
 * Without these tests, a regression that loosens the schema (e.g.
 * accepting `z.coerce.boolean()`) would silently let `irreversible:
 * "false"` flip to `true` and badge non-destructive tools as
 * irreversible.
 *
 * NOTE: full integration tests of the cross-process chain
 * (mca-tool-executor + permission-manager + streaming-state) require
 * a backend test harness that is out of scope for this PR. They are
 * tracked as a sub-issue under TER-186. The schema test pins the
 * contract that they will eventually rely on.
 */
import { describe, expect, it } from 'bun:test';

import { McaToolAnnotationsSchema } from '../../../../packages/shared/src/mca-protocol';

describe('McaToolAnnotationsSchema.irreversible', () => {
  it('accepts true', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.irreversible).toBe(true);
  });

  it('accepts false', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.irreversible).toBe(false);
  });

  it('accepts the field omitted', () => {
    const r = McaToolAnnotationsSchema.safeParse({});
    expect(r.success).toBe(true);
    // Schema is `optional()` without `.default(false)` deliberately —
    // call sites use `?? false` / `if (...)` patterns, no need to fill
    // a synthetic value. The omitted field stays `undefined`.
    if (r.success) expect(r.data.irreversible).toBeUndefined();
  });

  it('rejects "true" (string, common JSON-author bug)', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: 'true' });
    expect(r.success).toBe(false);
  });

  it('rejects "false" (string)', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: 'false' });
    expect(r.success).toBe(false);
  });

  it('rejects 1 (number truthy)', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: 1 });
    expect(r.success).toBe(false);
  });

  it('rejects null', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: null });
    expect(r.success).toBe(false);
  });

  it('rejects nested object', () => {
    const r = McaToolAnnotationsSchema.safeParse({ irreversible: { value: true } });
    expect(r.success).toBe(false);
  });

  it('still validates other annotation fields together', () => {
    const r = McaToolAnnotationsSchema.safeParse({
      version: '1.0.0',
      stability: 'stable',
      irreversible: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.version).toBe('1.0.0');
      expect(r.data.stability).toBe('stable');
      expect(r.data.irreversible).toBe(true);
    }
  });

  it('rejects bad stability even if irreversible is valid', () => {
    const r = McaToolAnnotationsSchema.safeParse({
      stability: 'wonky',
      irreversible: true,
    });
    expect(r.success).toBe(false);
  });
});
