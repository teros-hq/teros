import { describe, expect, it } from 'bun:test';
import {
  APIErrorCode,
  APIResponseError,
  ClientErrorCode,
  InvalidPathParameterError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from '@notionhq/client';
import { classifyNotionError, NotionApiError } from '../../src/lib/_notion-error';

/**
 * The classifier uses the SDK's official `isNotionClientError` type guard.
 * Tests instantiate REAL SDK error classes (APIResponseError,
 * RequestTimeoutError, UnknownHTTPResponseError, InvalidPathParameterError)
 * so they exercise the same instanceof path production hits.
 *
 * APIResponseError constructor (from @notionhq/client/build/src/errors.d.ts):
 *   new APIResponseError({ code, status, message, headers, rawBodyText,
 *                          additional_data, request_id })
 *
 * `headers` is the SupportedResponse['headers'] shape (`unknown` at the type
 * level); we pass `undefined` because the classifier never reads it.
 */

function apiError(code: APIErrorCode, status: number, message: string): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    // biome-ignore lint/suspicious/noExplicitAny: headers shape is unknown at type level
    headers: undefined as any,
    rawBodyText: `{"code":"${code}","message":"${message}"}`,
    additional_data: undefined,
    request_id: undefined,
  });
}

describe('classifyNotionError — APIResponseError', () => {
  const cases: Array<{ sdkCode: APIErrorCode; status: number; expected: string }> = [
    { sdkCode: APIErrorCode.Unauthorized, status: 401, expected: 'AUTH_EXPIRED' },
    { sdkCode: APIErrorCode.RestrictedResource, status: 403, expected: 'PERMISSION_DENIED' },
    { sdkCode: APIErrorCode.ObjectNotFound, status: 404, expected: 'NOT_FOUND' },
    { sdkCode: APIErrorCode.RateLimited, status: 429, expected: 'RATE_LIMITED' },
    { sdkCode: APIErrorCode.InvalidJSON, status: 400, expected: 'VALIDATION_ERROR' },
    { sdkCode: APIErrorCode.InvalidRequestURL, status: 400, expected: 'VALIDATION_ERROR' },
    { sdkCode: APIErrorCode.InvalidRequest, status: 400, expected: 'VALIDATION_ERROR' },
    { sdkCode: APIErrorCode.ValidationError, status: 400, expected: 'VALIDATION_ERROR' },
    { sdkCode: APIErrorCode.ConflictError, status: 409, expected: 'CONFLICT' },
    { sdkCode: APIErrorCode.InternalServerError, status: 500, expected: 'PROVIDER_ERROR' },
    { sdkCode: APIErrorCode.ServiceUnavailable, status: 503, expected: 'PROVIDER_ERROR' },
    { sdkCode: APIErrorCode.GatewayTimeout, status: 504, expected: 'PROVIDER_ERROR' },
  ];

  for (const { sdkCode, status, expected } of cases) {
    it(`maps ${sdkCode} (${status}) → ${expected}`, () => {
      const err = apiError(sdkCode, status, `upstream: ${sdkCode}`);
      const result = classifyNotionError(err);
      expect(result.code).toBe(expected as never);
      expect(result.message).toBe(`upstream: ${sdkCode}`);
      expect(result.action.description.length).toBeGreaterThan(0);
    });
  }
});

describe('classifyNotionError — ClientErrorCode (SDK transport errors)', () => {
  it('maps RequestTimeoutError → NETWORK_ERROR', () => {
    const err = new RequestTimeoutError('Notion request timed out');
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('Notion request timed out');
  });

  it('maps UnknownHTTPResponseError → NETWORK_ERROR', () => {
    const err = new UnknownHTTPResponseError({
      status: 502,
      message: 'Bad gateway from upstream proxy',
      // biome-ignore lint/suspicious/noExplicitAny: see top of file
      headers: undefined as any,
      rawBodyText: '<html>...</html>',
    });
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('Bad gateway from upstream proxy');
  });

  it('maps InvalidPathParameterError → VALIDATION_ERROR', () => {
    const err = new InvalidPathParameterError('path contains ".." segment');
    const result = classifyNotionError(err);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toBe('path contains ".." segment');
  });

  it('uses ClientErrorCode enum values explicitly', () => {
    // Defensive: confirm we have the enum we expect (a future SDK bump that
    // renames these values surfaces here).
    expect(ClientErrorCode.RequestTimeout).toBe('notionhq_client_request_timeout');
    expect(ClientErrorCode.ResponseError).toBe('notionhq_client_response_error');
    expect(ClientErrorCode.InvalidPathParameter).toBe('notionhq_client_invalid_path_parameter');
  });
});

describe('classifyNotionError — non-SDK errors', () => {
  it('detects ETIMEDOUT in generic Error message → NETWORK_ERROR', () => {
    const err = new Error('fetch failed: ETIMEDOUT after 30000ms');
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).toBe('fetch failed: ETIMEDOUT after 30000ms');
  });

  it('detects ECONNRESET → NETWORK_ERROR', () => {
    const err = new Error('socket ECONNRESET');
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
  });

  it('detects ENOTFOUND → NETWORK_ERROR', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.notion.com');
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
  });

  it('detects "fetch failed" → NETWORK_ERROR (Node 18 native fetch)', () => {
    const err = new Error('fetch failed');
    const result = classifyNotionError(err);
    expect(result.code).toBe('NETWORK_ERROR');
  });

  it('falls back to PROVIDER_ERROR for unrecognised generic Error', () => {
    const err = new Error('something went sideways');
    const result = classifyNotionError(err);
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(result.message).toBe('something went sideways');
  });

  it('stringifies a raw string throw → PROVIDER_ERROR', () => {
    const result = classifyNotionError('whoops');
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(result.message).toBe('whoops');
  });

  it('stringifies a thrown number → PROVIDER_ERROR', () => {
    const result = classifyNotionError(42);
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(result.message).toBe('42');
  });

  it('does NOT classify plain Error with `code` field as a Notion SDK error', () => {
    // Defensive: a duck-typed plain `Error` with `.code = "unauthorized"` is
    // not a NotionClientError. The classifier deliberately rejects it so
    // production code stays honest about what the SDK actually throws.
    // biome-ignore lint/suspicious/noExplicitAny: stub shape on purpose
    const err = new Error('forged') as any;
    err.code = APIErrorCode.Unauthorized;
    err.status = 401;
    const result = classifyNotionError(err);
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(result.message).toBe('forged');
  });
});

describe('classifyNotionError — NotionApiError pass-through', () => {
  it('returns the existing classification when already wrapped', () => {
    const original = new NotionApiError({
      code: 'PERMISSION_DENIED',
      action: { type: 'user_action', description: 'Share the page.' },
      message: 'Share the page first',
    });
    const result = classifyNotionError(original);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.message).toBe('Share the page first');
  });
});

describe('NotionApiError constructor', () => {
  it('prepends [CODE] to message so the agent can route on it', () => {
    const err = new NotionApiError({
      code: 'AUTH_EXPIRED',
      action: { type: 'user_action', description: 'Reconnect.' },
      message: 'API token is invalid.',
    });
    expect(err.message).toBe('[AUTH_EXPIRED] API token is invalid.');
    expect(err.upstreamMessage).toBe('API token is invalid.');
    expect(err.classified.code).toBe('AUTH_EXPIRED');
    expect(err.name).toBe('NotionApiError');
  });

  it('keeps the upstream message verbatim — never edits it', () => {
    const verbatim =
      'body failed validation: body.properties.Name should be defined, instead was `undefined`.';
    const err = new NotionApiError({
      code: 'VALIDATION_ERROR',
      action: { type: 'user_action', description: 'see message' },
      message: verbatim,
    });
    expect(err.upstreamMessage).toBe(verbatim);
    expect(err.message).toBe(`[VALIDATION_ERROR] ${verbatim}`);
  });

  it('is detectable via instanceof for upstream handlers', () => {
    const err = new NotionApiError({
      code: 'RATE_LIMITED',
      action: { type: 'auto_retry', description: 'retry' },
      message: 'too many requests',
    });
    expect(err instanceof NotionApiError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('classifyNotionError — IssueAction descriptions are non-empty for every IssueCode', () => {
  const allCodes = [
    'AUTH_EXPIRED',
    'AUTH_REQUIRED',
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'RATE_LIMITED',
    'VALIDATION_ERROR',
    'CONFLICT',
    'PROVIDER_ERROR',
    'NETWORK_ERROR',
    'SYSTEM_CONFIG_MISSING',
  ] as const;

  for (const code of allCodes) {
    it(`${code} has a non-empty action description`, () => {
      const err = new NotionApiError({
        code,
        action: { type: 'user_action', description: 'x' },
        message: 'm',
      });
      const result = classifyNotionError(err);
      expect(result.action.description.length).toBeGreaterThan(0);
    });
  }
});
