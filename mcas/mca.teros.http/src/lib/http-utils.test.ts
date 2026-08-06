import { describe, expect, it } from 'bun:test';
import {
  hasPlaceholders,
  maskByName,
  redactRecord,
  redactUrl,
  resolveTimeout,
  scrubSecrets,
  substituteSecrets,
  substituteSecretsInUrl,
} from './http-utils';

describe('substituteSecrets', () => {
  it('replaces a single placeholder with the stored secret value', () => {
    expect(substituteSecrets('Bearer {{TOKEN}}', { TOKEN: 'abc123' })).toBe('Bearer abc123');
  });

  it('replaces multiple distinct placeholders', () => {
    expect(substituteSecrets('{{A}}-{{B}}', { A: 'x', B: 'y' })).toBe('x-y');
  });

  it('replaces the same placeholder used twice', () => {
    expect(substituteSecrets('{{K}}/{{K}}', { K: 'z' })).toBe('z/z');
  });

  it('tolerates inner whitespace in the placeholder', () => {
    expect(substituteSecrets('{{ TOKEN }}', { TOKEN: 'v' })).toBe('v');
  });

  it('leaves a string without placeholders untouched', () => {
    expect(substituteSecrets('https://api.example.com/x', { K: '1' })).toBe(
      'https://api.example.com/x',
    );
  });

  it('throws [MISSING_SECRET] when a referenced secret is absent', () => {
    expect(() => substituteSecrets('{{NOPE}}', {})).toThrow('[MISSING_SECRET]');
  });

  it('names the missing secret in the error', () => {
    expect(() => substituteSecrets('{{HUNTER_API_KEY}}', {})).toThrow('HUNTER_API_KEY');
  });

  it('throws when the secret exists but is empty (treated as not configured)', () => {
    expect(() => substituteSecrets('{{E}}', { E: '' })).toThrow('[MISSING_SECRET]');
  });

  it('collects every resolved value into the optional used set', () => {
    const used = new Set<string>();
    substituteSecrets('{{A}}-{{B}}-{{A}}', { A: 'x', B: 'y' }, used);
    expect([...used].sort()).toEqual(['x', 'y']);
  });

  it('throws [BAD_PLACEHOLDER] on a malformed {{ ... }} reference', () => {
    expect(() => substituteSecrets('{{ bad-name }}', { 'bad-name': 'v' })).toThrow(
      '[BAD_PLACEHOLDER]',
    );
  });

  it('throws [BAD_PLACEHOLDER] even when an earlier valid placeholder resolved', () => {
    expect(() => substituteSecrets('{{good}} then {{also-bad}}', { good: 'g' })).toThrow(
      '[BAD_PLACEHOLDER]',
    );
  });

  it('does NOT flag a lone {{ with no closing pair (left verbatim)', () => {
    expect(substituteSecrets('a {{ b c', {})).toBe('a {{ b c');
  });
});

describe('hasPlaceholders', () => {
  it('is true when a valid {{NAME}} is present', () => {
    expect(hasPlaceholders('Bearer {{TOKEN}}')).toBe(true);
    expect(hasPlaceholders('{{ A }}')).toBe(true);
  });

  it('is false for plain text and for a malformed reference', () => {
    expect(hasPlaceholders('https://api.example.com/x')).toBe(false);
    expect(hasPlaceholders('{{ bad-name }}')).toBe(false);
  });

  it('is stateless across calls (global RE lastIndex does not leak)', () => {
    expect(hasPlaceholders('{{X}}')).toBe(true);
    expect(hasPlaceholders('{{X}}')).toBe(true);
  });
});

describe('substituteSecretsInUrl', () => {
  it('percent-encodes URL metacharacters in the resolved value', () => {
    expect(substituteSecretsInUrl('https://h/{{T}}', { T: 'a/b c' })).toBe('https://h/a%2Fb%20c');
  });

  it('collects the RAW (un-encoded) value into the used set', () => {
    const used = new Set<string>();
    substituteSecretsInUrl('https://h/{{T}}', { T: 'a/b' }, used);
    expect([...used]).toEqual(['a/b']);
  });

  it('throws [MISSING_SECRET] like the plain variant', () => {
    expect(() => substituteSecretsInUrl('{{X}}', {})).toThrow('[MISSING_SECRET]');
  });
});

describe('resolveTimeout', () => {
  it('returns the default for non-finite input', () => {
    expect(resolveTimeout(undefined, 30000, 120000)).toBe(30000);
    expect(resolveTimeout(Number.NaN, 30000, 120000)).toBe(30000);
    expect(resolveTimeout('abc', 30000, 120000)).toBe(30000);
    expect(resolveTimeout(Number.POSITIVE_INFINITY, 30000, 120000)).toBe(30000);
  });

  it('clamps finite input to [1000, max]', () => {
    expect(resolveTimeout(500, 30000, 120000)).toBe(1000);
    expect(resolveTimeout(999999, 30000, 120000)).toBe(120000);
    expect(resolveTimeout(5000, 30000, 120000)).toBe(5000);
  });

  it('accepts a numeric string', () => {
    expect(resolveTimeout('5000', 30000, 120000)).toBe(5000);
  });
});

describe('scrubSecrets', () => {
  it('replaces a value everywhere across a nested structure', () => {
    expect(
      scrubSecrets({ a: 'x SEK y', b: ['SEK', { c: 'pre-SEK-post' }], n: 1, ok: true }, ['SEK']),
    ).toEqual({ a: 'x *** y', b: ['***', { c: 'pre-***-post' }], n: 1, ok: true });
  });

  it('also scrubs the percent-encoded form of the value', () => {
    expect(scrubSecrets({ q: 'tok=a%2Fb' }, ['a/b'])).toEqual({ q: 'tok=***' });
  });

  it('scrubs string-valued object keys too', () => {
    expect(scrubSecrets<Record<string, number>>({ SEK: 1 }, ['SEK'])).toEqual({ '***': 1 });
  });

  it('replaces the longer of two overlapping values first (no partial leak)', () => {
    expect(scrubSecrets('xx abcd yy', ['ab', 'abcd'])).toBe('xx *** yy');
  });

  it('is an identity no-op when there are no secret values', () => {
    const v = { a: 'keep' };
    expect(scrubSecrets(v, [])).toBe(v);
  });

  it('scrubs a plain string', () => {
    expect(scrubSecrets('Bearer SEK', ['SEK'])).toBe('Bearer ***');
  });
});

describe('maskByName', () => {
  it('masks an Authorization header value', () => {
    expect(maskByName('authorization', 'Bearer secret-xyz')).toBe('***');
  });

  it('is case-insensitive on the name', () => {
    expect(maskByName('Authorization', 'Bearer secret-xyz')).toBe('***');
  });

  it.each(['x-api-key', 'api_key', 'apikey', 'cookie', 'set-cookie', 'x-auth-token'])(
    'masks credential-named header %s',
    (name) => {
      expect(maskByName(name, 'literal-secret')).toBe('***');
    },
  );

  it('passes a non-sensitive header through unchanged', () => {
    expect(maskByName('accept', 'application/json')).toBe('application/json');
    expect(maskByName('content-type', 'application/json')).toBe('application/json');
  });

  it('passes a bare {{PLACEHOLDER}} through even for a sensitive name (not a real secret)', () => {
    expect(maskByName('api-key', '{{BREVO_API_KEY}}')).toBe('{{BREVO_API_KEY}}');
    expect(maskByName('authorization', '{{TOKEN}}')).toBe('{{TOKEN}}');
  });
});

describe('redactUrl', () => {
  it('masks a literal api_key in the query string', () => {
    expect(redactUrl('https://api.hunter.io/v2/domain-search?domain=x.com&api_key=SECRET123')).toBe(
      'https://api.hunter.io/v2/domain-search?domain=x.com&api_key=***',
    );
  });

  it('masks literal key= and token= and auth=', () => {
    expect(redactUrl('https://h/x?key=AAA')).toBe('https://h/x?key=***');
    expect(redactUrl('https://h/x?token=BBB&q=1')).toBe('https://h/x?token=***&q=1');
    expect(redactUrl('https://h/x?auth=CCC')).toBe('https://h/x?auth=***');
  });

  it('keeps a {{placeholder}} intact (it is not a real secret)', () => {
    expect(redactUrl('https://h/x?api_key={{HUNTER_API_KEY}}')).toBe(
      'https://h/x?api_key={{HUNTER_API_KEY}}',
    );
  });

  it('does not touch non-credential params', () => {
    expect(redactUrl('https://h/x?domain=acme.com&limit=10')).toBe(
      'https://h/x?domain=acme.com&limit=10',
    );
  });
});

describe('redactRecord', () => {
  it('masks only the credential-named entries', () => {
    expect(redactRecord({ authorization: 'Bearer z', accept: 'application/json' })).toEqual({
      authorization: '***',
      accept: 'application/json',
    });
  });

  it('returns an empty object for an empty record', () => {
    expect(redactRecord({})).toEqual({});
  });
});
