/**
 * Agent mailbox naming — unit tests (tn_PcquTN30AawbK8uE).
 *
 * Pins the normalization and local-part shape of the clean-first naming
 * algorithm. The DB/Stalwart paths (ensureMailbox, adoptMailbox) are
 * integration-tested on RAW. Signature tests live in the MCA
 * (mcas/mca.teros.email/test/unit/signature.test.ts).
 */
import { describe, expect, it } from 'bun:test';
import { slugify } from '../../src/services/agent-mailbox-service';

/** Local part must be [a-z0-9] only (hyphen solely as agent-owner separator). */
const LOCAL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('slugify', () => {
  it('normalizes accents to ASCII', () => {
    expect(slugify('Nira')).toBe('nira');
    expect(slugify('José María')).toBe('josemaria');
    expect(slugify('Ünter')).toBe('unter');
  });

  it('drops spaces and punctuation, lowercases', () => {
    expect(slugify('Alice Cooper')).toBe('alicecooper');
    expect(slugify('Kai-2!')).toBe('kai2');
    expect(slugify('  Luna  ')).toBe('luna');
  });

  it('empty for input without [a-z0-9]', () => {
    expect(slugify('---')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('clean-first local-part shape (LOCAL_RE)', () => {
  it('accepts clean local parts', () => {
    expect(LOCAL_RE.test('nira')).toBe(true);
    expect(LOCAL_RE.test('chen-marcos')).toBe(true);
    expect(LOCAL_RE.test('luna2-pablo')).toBe(true);
  });

  it('rejects dirty local parts (double hyphens, symbols, spaces, uppercase)', () => {
    expect(LOCAL_RE.test('ni--ra')).toBe(false); // double hyphen — empty part
    expect(LOCAL_RE.test('nira_')).toBe(false);
    expect(LOCAL_RE.test('Nira')).toBe(false);
    expect(LOCAL_RE.test('nira pablo')).toBe(false);
    expect(LOCAL_RE.test('-nira')).toBe(false);
  });
});
