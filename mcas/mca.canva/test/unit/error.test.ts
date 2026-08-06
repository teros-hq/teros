import { describe, expect, it } from 'bun:test';
import { CanvaApiError, classifyCanvaApiError } from '../../src/lib/_canva-error';

describe('classifyCanvaApiError', () => {
  it('401 → AUTH_EXPIRED + user_action reconnect', () => {
    const c = classifyCanvaApiError(401, { message: 'Invalid token' });
    expect(c.code).toBe('AUTH_EXPIRED');
    expect(c.action.type).toBe('user_action');
    expect(c.action.description).toMatch(/Reconnect/i);
    // Literal upstream message preserved
    expect(c.message).toBe('Invalid token');
  });

  it('403 → PERMISSION_DENIED with scope hint', () => {
    const c = classifyCanvaApiError(403, { message: 'Missing scope: brandtemplate' });
    expect(c.code).toBe('PERMISSION_DENIED');
    expect(c.action.description).toMatch(/scope/i);
    expect(c.message).toBe('Missing scope: brandtemplate');
  });

  it('404 → NOT_FOUND', () => {
    const c = classifyCanvaApiError(404, { message: 'Design not found' });
    expect(c.code).toBe('NOT_FOUND');
    expect(c.message).toBe('Design not found');
  });

  it('429 → RATE_LIMITED + auto_retry', () => {
    const c = classifyCanvaApiError(429, { message: 'Too many requests' });
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.action.type).toBe('auto_retry');
  });

  it('400/422 → VALIDATION_ERROR', () => {
    expect(classifyCanvaApiError(400, { message: 'Bad' }).code).toBe('VALIDATION_ERROR');
    expect(classifyCanvaApiError(422, { message: 'Bad' }).code).toBe('VALIDATION_ERROR');
  });

  it('5xx → PROVIDER_ERROR + auto_retry', () => {
    const c = classifyCanvaApiError(500, { message: 'Internal error' });
    expect(c.code).toBe('PROVIDER_ERROR');
    expect(c.action.type).toBe('auto_retry');
  });

  it('extracts error_description over message when present', () => {
    const c = classifyCanvaApiError(401, { error_description: 'token expired' });
    expect(c.message).toBe('token expired');
  });

  it('falls back to `error` field for Canva 5xx body shapes', () => {
    // Real shape returned by list-folders { pinStatus: "pinned" }: 501
    // with body `{ statusCode: 501, error: "server error" }` — without
    // unwrapping `error` we surface the raw JSON to the caller.
    const c = classifyCanvaApiError(501, { statusCode: 501, error: 'server error' });
    expect(c.message).toBe('server error');
    expect(c.code).toBe('PROVIDER_ERROR');
  });

  it('falls back to fallbackMessage on empty body', () => {
    const c = classifyCanvaApiError(500, '');
    expect(c.message).toBe('Canva API error');
  });

  it('handles plain-text body', () => {
    const c = classifyCanvaApiError(503, 'Service Unavailable');
    expect(c.message).toBe('Service Unavailable');
    expect(c.code).toBe('PROVIDER_ERROR');
  });

  it('NEVER tunes the upstream message — only description is curated', () => {
    const literalMessage = "Calendar API not enabled in project 12345";
    const c = classifyCanvaApiError(403, { message: literalMessage });
    expect(c.message).toBe(literalMessage);
    expect(c.action.description).not.toBe(literalMessage);
  });
});

describe('CanvaApiError', () => {
  it('wraps classification with status + message', () => {
    const classified = classifyCanvaApiError(404, { message: 'Not found' });
    const err = new CanvaApiError(404, classified);
    expect(err.name).toBe('CanvaApiError');
    expect(err.status).toBe(404);
    expect(err.message).toContain('404');
    expect(err.message).toContain('Not found');
    expect(err.classified).toBe(classified);
  });

  it('is instanceof Error', () => {
    const err = new CanvaApiError(500, classifyCanvaApiError(500, {}));
    expect(err).toBeInstanceOf(Error);
  });
});
