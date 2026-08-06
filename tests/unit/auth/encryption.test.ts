/**
 * Unit — AES-256-GCM encryption boundary (TER-450)
 *
 * `encrypt`/`decrypt` protect user OAuth tokens and secrets at rest. A silent
 * regression here (wrong key length accepted, tampered ciphertext decrypting,
 * reused IV) would be a confidentiality/integrity hole that no higher-level
 * test exercises. These assert the authenticated-encryption invariants directly.
 */

import { describe, expect, it } from 'bun:test';
import { decrypt, encrypt, generateKey, generateSalt } from '../../../packages/backend/src/auth/encryption';

describe('encryption — AES-256-GCM', () => {
  const key = generateKey();

  it('round-trips structured data unchanged', () => {
    const payload = { token: 'xoxb-abc', nested: { n: 1, arr: [true, 'x'] }, when: 'now' };
    const out = decrypt(encrypt(payload, key), key);
    expect(out).toEqual(payload);
  });

  it('round-trips primitives and empty values', () => {
    for (const v of ['', 'plain string', 0, false, null, [], {}]) {
      expect(decrypt(encrypt(v, key), key)).toEqual(v as never);
    }
  });

  it('produces a unique IV per call (no nonce reuse)', () => {
    const a = encrypt({ x: 1 }, key);
    const b = encrypt({ x: 1 }, key);
    // Same plaintext + same key MUST yield different IV and ciphertext.
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('emits a 16-byte IV and 16-byte auth tag (hex)', () => {
    const e = encrypt({ x: 1 }, key);
    expect(e.iv).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(e.tag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
  });

  it('rejects a key that is not exactly 32 bytes — encrypt', () => {
    expect(() => encrypt({ x: 1 }, Buffer.alloc(16))).toThrow('Encryption key must be 32 bytes');
    expect(() => encrypt({ x: 1 }, Buffer.alloc(31))).toThrow('Encryption key must be 32 bytes');
    expect(() => encrypt({ x: 1 }, Buffer.alloc(33))).toThrow('Encryption key must be 32 bytes');
  });

  it('rejects a key that is not exactly 32 bytes — decrypt', () => {
    const e = encrypt({ x: 1 }, key);
    expect(() => decrypt(e, Buffer.alloc(16))).toThrow('Decryption key must be 32 bytes');
  });

  it('fails decryption with the wrong key', () => {
    const e = encrypt({ secret: 1 }, key);
    expect(() => decrypt(e, generateKey())).toThrow();
  });

  it('fails decryption when the ciphertext is tampered (GCM integrity)', () => {
    const e = encrypt({ secret: 'do-not-flip' }, key);
    const flipped = { ...e, data: flipLastHexNibble(e.data) };
    expect(() => decrypt(flipped, key)).toThrow();
  });

  it('fails decryption when the auth tag is tampered', () => {
    const e = encrypt({ secret: 'x' }, key);
    const badTag = { ...e, tag: flipLastHexNibble(e.tag) };
    expect(() => decrypt(badTag, key)).toThrow();
  });

  it('fails decryption when the IV is altered', () => {
    const e = encrypt({ secret: 'x' }, key);
    const badIv = { ...e, iv: flipLastHexNibble(e.iv) };
    expect(() => decrypt(badIv, key)).toThrow();
  });

  it('generateKey / generateSalt produce 32 random bytes', () => {
    expect(generateKey().length).toBe(32);
    expect(generateSalt().length).toBe(32);
    expect(generateKey().equals(generateKey())).toBe(false);
  });
});

/** Flip the last hex nibble so the buffer changes by exactly one bit-group. */
function flipLastHexNibble(hex: string): string {
  const last = hex.slice(-1);
  const flipped = (Number.parseInt(last, 16) ^ 0xf).toString(16);
  return hex.slice(0, -1) + flipped;
}
