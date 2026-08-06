/**
 * Tests for mergeCuratedAnnotations (TER-522 Pieza I.b).
 *
 * The contract that must hold so a future `generate-mca-tools` regen never
 * wipes the 1000+ curated catalog descriptions:
 *   - code-declared annotations WIN (never overwritten by curation)
 *   - curated summary/group fill in only what the code omits
 *   - everything else (version, hints…) is preserved
 *   - an empty result collapses to `undefined` (so the key is omitted)
 */

import { describe, expect, it } from 'bun:test';
import { mergeCuratedAnnotations } from '../../../scripts/lib/tool-annotations';

describe('mergeCuratedAnnotations', () => {
  it('fills summary+group from curation when the code declares none', () => {
    const out = mergeCuratedAnnotations(undefined, { summary: 'List inbox or label messages', group: 'Messages' });
    expect(out).toEqual({ summary: 'List inbox or label messages', group: 'Messages' });
  });

  it('does NOT overwrite a code-declared summary with curation', () => {
    const out = mergeCuratedAnnotations(
      { summary: 'CODE summary', group: 'CODE group' },
      { summary: 'curated summary', group: 'curated group' },
    );
    // Code is the source of truth — curation must not clobber it.
    expect(out).toEqual({ summary: 'CODE summary', group: 'CODE group' });
  });

  it('fills only the missing field (code has summary, curation supplies group)', () => {
    const out = mergeCuratedAnnotations(
      { summary: 'CODE summary' },
      { summary: 'curated summary', group: 'curated group' },
    );
    expect(out).toEqual({ summary: 'CODE summary', group: 'curated group' });
  });

  it('preserves unrelated code annotations (version, hints) while adding curation', () => {
    const out = mergeCuratedAnnotations(
      { version: '1.0.0', readOnlyHint: true },
      { summary: 'Open a single email', group: 'Messages' },
    );
    expect(out).toEqual({ version: '1.0.0', readOnlyHint: true, summary: 'Open a single email', group: 'Messages' });
  });

  it('returns undefined when there is nothing to write (no code annotations, no curation)', () => {
    expect(mergeCuratedAnnotations(undefined, undefined)).toBeUndefined();
    expect(mergeCuratedAnnotations({}, undefined)).toBeUndefined();
    expect(mergeCuratedAnnotations({}, {})).toBeUndefined();
  });

  it('keeps code annotations when curation is absent', () => {
    const out = mergeCuratedAnnotations({ version: '2.0.0' }, undefined);
    expect(out).toEqual({ version: '2.0.0' });
  });

  it('ignores empty-string curation (treats it as absent)', () => {
    const out = mergeCuratedAnnotations({ group: 'Files' }, { summary: '', group: '' });
    // Empty strings are falsy — must not produce empty summary/group keys.
    expect(out).toEqual({ group: 'Files' });
  });

  it('does not mutate the input annotations object', () => {
    const code = { version: '1.0.0' };
    mergeCuratedAnnotations(code, { summary: 'X', group: 'Y' });
    expect(code).toEqual({ version: '1.0.0' });
  });
});
