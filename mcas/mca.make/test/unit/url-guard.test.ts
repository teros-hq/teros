import { describe, expect, test } from 'bun:test';
import { MakeError } from '../../src/lib/errors';
import { parseMakeWebhookUrl, regionFromHost } from '../../src/lib/url-guard';

/** Capture the thrown MakeError (or fail). */
function thrownBy(fn: () => unknown): MakeError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MakeError) return e;
    throw e;
  }
  throw new Error('expected the call to throw a MakeError, but it did not');
}

describe('parseMakeWebhookUrl — accepts valid Make webhook hosts', () => {
  test('canonical eu1 webhook', () => {
    const r = parseMakeWebhookUrl('https://hook.eu1.make.com/abc123token');
    expect(r.host).toBe('hook.eu1.make.com');
    expect(r.region).toBe('eu1');
    expect(r.url).toBe('https://hook.eu1.make.com/abc123token');
  });

  test('all four documented regions', () => {
    expect(parseMakeWebhookUrl('https://hook.eu1.make.com/t').region).toBe('eu1');
    expect(parseMakeWebhookUrl('https://hook.eu2.make.com/t').region).toBe('eu2');
    expect(parseMakeWebhookUrl('https://hook.us1.make.com/t').region).toBe('us1');
    expect(parseMakeWebhookUrl('https://hook.us2.make.com/t').region).toBe('us2');
  });

  test('host is lowercased', () => {
    expect(parseMakeWebhookUrl('https://HOOK.EU1.MAKE.COM/t').host).toBe('hook.eu1.make.com');
  });
});

describe('parseMakeWebhookUrl — SSRF host allowlist (rejects arbitrary hosts)', () => {
  test('rejects a totally unrelated host with [BAD_REQUEST]', () => {
    const e = thrownBy(() => parseMakeWebhookUrl('https://evil.com/steal'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message.startsWith('[BAD_REQUEST]')).toBe(true);
  });

  test('rejects an internal/loopback host', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('https://127.0.0.1/x')).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl('https://localhost/x')).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl('https://169.254.169.254/latest/meta-data')).code).toBe(
      'BAD_REQUEST',
    );
  });

  test('rejects a suffix-spoof host (make.com is not the final label)', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('https://hook.eu1.make.com.evil.com/t')).code).toBe(
      'BAD_REQUEST',
    );
  });

  test('rejects a substring-but-not-subdomain host (notmake.com / xmake.com)', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('https://notmake.com/t')).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl('https://xmake.com/t')).code).toBe('BAD_REQUEST');
  });

  test('rejects the userinfo @-trick (real host after @ is not make.com)', () => {
    // new URL() attributes the host as the part AFTER '@' → evil.com
    const e = thrownBy(() => parseMakeWebhookUrl('https://hook.eu1.make.com@evil.com/t'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toContain('evil.com');
  });

  test('rejects the apex make.com (no webhook subdomain)', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('https://make.com/t')).code).toBe('BAD_REQUEST');
  });
});

describe('parseMakeWebhookUrl — protocol + shape guards', () => {
  test('rejects http (non-https)', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('http://hook.eu1.make.com/t')).code).toBe(
      'BAD_REQUEST',
    );
  });

  test('rejects javascript: pseudo-protocol', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('javascript:alert(1)//hook.eu1.make.com')).code).toBe(
      'BAD_REQUEST',
    );
  });

  test('rejects ftp:', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('ftp://hook.eu1.make.com/t')).code).toBe(
      'BAD_REQUEST',
    );
  });

  test('rejects an explicit non-443 port (even on a valid make.com host)', () => {
    const e = thrownBy(() => parseMakeWebhookUrl('https://hook.eu1.make.com:8080/t'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toContain('8080');
  });

  test('accepts an explicit :443 (the default https port)', () => {
    const r = parseMakeWebhookUrl('https://hook.eu1.make.com:443/t');
    expect(r.host).toBe('hook.eu1.make.com');
    expect(r.region).toBe('eu1');
  });

  test('rejects an unparseable URL', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('not a url at all')).code).toBe('BAD_REQUEST');
  });

  test('rejects empty / non-string input', () => {
    expect(thrownBy(() => parseMakeWebhookUrl('')).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl('   ')).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl(null)).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl(undefined)).code).toBe('BAD_REQUEST');
    expect(thrownBy(() => parseMakeWebhookUrl(42)).code).toBe('BAD_REQUEST');
  });
});

describe('regionFromHost', () => {
  test('extracts the region segment', () => {
    expect(regionFromHost('hook.eu1.make.com')).toBe('eu1');
    expect(regionFromHost('hook.us2.make.com')).toBe('us2');
  });

  test('returns null for non-standard make hosts', () => {
    expect(regionFromHost('webhook.make.com')).toBeNull();
    expect(regionFromHost('eu1.make.com')).toBeNull();
  });
});
