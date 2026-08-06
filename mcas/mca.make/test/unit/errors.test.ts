import { describe, expect, test } from 'bun:test';
import { extractMakeApiMessage, MakeError, makeErrorFromStatus } from '../../src/lib/errors';

describe('MakeError', () => {
  test('prefixes message with [CODE] and preserves the literal upstream message', () => {
    const e = new MakeError('NOT_FOUND', 'Scenario 5 not found', 404);
    expect(e.message).toBe('[NOT_FOUND] Scenario 5 not found');
    expect(e.upstreamMessage).toBe('Scenario 5 not found');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.status).toBe(404);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MakeError');
  });

  test('status is optional', () => {
    const e = new MakeError('BAD_REQUEST', 'bad host');
    expect(e.status).toBeUndefined();
    expect(e.message).toBe('[BAD_REQUEST] bad host');
  });
});

describe('makeErrorFromStatus', () => {
  test.each([
    [400, 'BAD_REQUEST'],
    [401, 'AUTH_INVALID'],
    [403, 'AUTH_INVALID'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'DEPENDENCY_UNAVAILABLE'],
    [502, 'DEPENDENCY_UNAVAILABLE'],
    [503, 'DEPENDENCY_UNAVAILABLE'],
    [418, 'UPSTREAM_ERROR'],
    [451, 'UPSTREAM_ERROR'],
  ] as const)('status %i → code %s', (status, code) => {
    const e = makeErrorFromStatus(status, 'm');
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
    expect(e.upstreamMessage).toBe('m');
  });
});

describe('extractMakeApiMessage', () => {
  test('reads .message', () => {
    expect(extractMakeApiMessage('{"message":"boom"}', 400)).toBe('boom');
  });

  test('reads .detail', () => {
    expect(extractMakeApiMessage('{"detail":"nope"}', 400)).toBe('nope');
  });

  test('reads .error (provider 5xx / not-implemented shape)', () => {
    expect(extractMakeApiMessage('{"statusCode":501,"error":"server error"}', 501)).toBe(
      'server error',
    );
  });

  test('reads .error_description', () => {
    expect(extractMakeApiMessage('{"error_description":"token expired"}', 401)).toBe(
      'token expired',
    );
  });

  test('reads nested errors[0].message', () => {
    expect(extractMakeApiMessage('{"errors":[{"message":"bad field"}]}', 422)).toBe('bad field');
  });

  test('reads errors[0] when it is a string', () => {
    expect(extractMakeApiMessage('{"errors":["plain error"]}', 422)).toBe('plain error');
  });

  test('falls back to status + snippet on non-JSON body', () => {
    const out = extractMakeApiMessage('plain text error', 500);
    expect(out).toContain('500');
    expect(out).toContain('plain text error');
  });

  test('falls back to status-only on empty body', () => {
    expect(extractMakeApiMessage('', 500)).toBe('Make API error (500)');
    expect(extractMakeApiMessage('   ', 500)).toBe('Make API error (500)');
  });

  test('ignores empty/whitespace message fields and falls back', () => {
    const out = extractMakeApiMessage('{"message":"   "}', 503);
    expect(out).toContain('503');
  });
});
