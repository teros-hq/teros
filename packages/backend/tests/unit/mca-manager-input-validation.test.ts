/**
 * Regression test: mca-manager must NOT reject large tool inputs.
 *
 * Bug: filesystem_write and bash fail with "content is required" /
 * "command is required" when the payload is large.
 *
 * Root cause: validateToolInputSize() in mca-manager.ts hard-rejected any
 * serialized input > 40,000 chars. The MCA HTTP server handles large payloads
 * fine (up to 10 MB); the 40 KB cap was an artificial backend limit.
 *
 * Fix: remove validateToolInputSize and its call site entirely.
 *
 * These tests verify the fix is in place by inspecting the source directly.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '../../src/services/mca-manager.ts'),
  'utf-8',
);

describe('mca-manager.ts: input size limit removed', () => {
  it('does not define MAX_TOOL_INPUT_CHARS', () => {
    expect(source).not.toContain('MAX_TOOL_INPUT_CHARS');
  });

  it('does not define validateToolInputSize', () => {
    expect(source).not.toContain('validateToolInputSize');
  });

  it('does not call validateToolInputSize', () => {
    expect(source).not.toContain('validateToolInputSize(');
  });
});
