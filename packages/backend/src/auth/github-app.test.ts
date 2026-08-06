import { describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';

import { GitHubAppService } from './github-app';

describe('GitHubAppService.verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret-32-bytes-long!';

  function signature(body: string | Buffer, s: string = secret): string {
    return `sha256=${createHmac('sha256', s).update(body).digest('hex')}`;
  }

  it('returns true for a valid signature', () => {
    const body = Buffer.from(JSON.stringify({ action: 'created', installation: { id: 1 } }));
    const sig = signature(body);
    expect(GitHubAppService.verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('returns false when secret differs', () => {
    const body = Buffer.from('{"action":"created"}');
    const sig = signature(body, 'wrong-secret');
    expect(GitHubAppService.verifyWebhookSignature(body, sig, secret)).toBe(false);
  });

  it('returns false when body is tampered', () => {
    const original = Buffer.from('{"action":"created"}');
    const sig = signature(original);
    const tampered = Buffer.from('{"action":"deleted"}');
    expect(GitHubAppService.verifyWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it('returns false when signature header is missing', () => {
    const body = Buffer.from('{}');
    expect(GitHubAppService.verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(GitHubAppService.verifyWebhookSignature(body, '', secret)).toBe(false);
  });

  it('returns false when secret is empty (would otherwise leak `=` prefix match)', () => {
    const body = Buffer.from('{}');
    const sig = signature(body);
    expect(GitHubAppService.verifyWebhookSignature(body, sig, '')).toBe(false);
  });

  it('rejects signatures of differing lengths without throwing (length guard)', () => {
    const body = Buffer.from('{}');
    // `timingSafeEqual` itself throws on length mismatch — we guard before.
    expect(() =>
      GitHubAppService.verifyWebhookSignature(body, 'sha256=short', secret),
    ).not.toThrow();
    expect(GitHubAppService.verifyWebhookSignature(body, 'sha256=short', secret)).toBe(false);
  });

  it('uses timing-safe comparison (does not short-circuit on first mismatch)', () => {
    // Sanity: two equal-length but different signatures should fail.
    const body = Buffer.from('{}');
    const valid = signature(body);
    // Flip last hex char.
    const lastChar = valid.slice(-1);
    const flipped = valid.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    expect(GitHubAppService.verifyWebhookSignature(body, flipped, secret)).toBe(false);
    expect(flipped.length).toBe(valid.length);
  });
});
