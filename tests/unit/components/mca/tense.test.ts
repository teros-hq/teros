/**
 * Tests for tenseByStatus helper (Renderer UX Guide v2 §2).
 *
 * The helper produces the right verb tense for the Tool Call Card
 * description based on the current execution status.
 */
import { describe, expect, it } from 'bun:test';

import { tenseByStatus } from '../../../../packages/app/src/components/mca/primitives/tense';

const forms = {
  future: 'list events',
  present: 'Listing events',
  past: 'Listed 3 events',
};

describe('tenseByStatus', () => {
  it('uses the future form prefixed with "Will" for pending', () => {
    expect(tenseByStatus('pending', forms)).toBe('Will list events');
  });

  it('appends an ellipsis to the present form for running', () => {
    expect(tenseByStatus('running', forms)).toBe('Listing events…');
  });

  it('returns the past form verbatim for completed', () => {
    expect(tenseByStatus('completed', forms)).toBe('Listed 3 events');
  });

  it('uses "Failed to <future>" for failed', () => {
    expect(tenseByStatus('failed', forms)).toBe('Failed to list events');
  });

  it('uses "Wants to <future>" for pending_permission', () => {
    expect(tenseByStatus('pending_permission', forms)).toBe('Wants to list events');
  });

  it('capitalizes the first letter when prefixing', () => {
    // future is already lowercase, prefix capitalization should win
    const out = tenseByStatus('failed', { future: 'send email', present: 'x', past: 'x' });
    expect(out.charAt(0)).toBe('F');
  });

  it('handles empty future form without crashing', () => {
    const out = tenseByStatus('pending', { future: '', present: 'x', past: 'x' });
    expect(out).toBe('Will ');
  });
});
