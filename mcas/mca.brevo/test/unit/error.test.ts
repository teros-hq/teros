import { describe, expect, it } from 'bun:test';
import {
  BrevoApiError,
  classifyBrevoError,
  extractBrevoMessage,
} from '../../src/lib/_brevo-error';

describe('classifyBrevoError', () => {
  it('401 → AUTH_INVALID + user_action, literal message preserved', () => {
    const c = classifyBrevoError(401, { code: 'unauthorized', message: 'Key not found' });
    expect(c.code).toBe('AUTH_INVALID');
    expect(c.action.type).toBe('user_action');
    expect(c.action.description).toMatch(/API key/i);
    expect(c.message).toBe('Key not found');
  });

  it('403 → PERMISSION_DENIED with sender/scope hint', () => {
    const c = classifyBrevoError(403, { message: 'Sender not valid' });
    expect(c.code).toBe('PERMISSION_DENIED');
    expect(c.action.type).toBe('user_action');
    expect(c.action.description).toMatch(/verified|permission/i);
    expect(c.message).toBe('Sender not valid');
  });

  it('404 → NOT_FOUND', () => {
    const c = classifyBrevoError(404, { message: 'Contact does not exist' });
    expect(c.code).toBe('NOT_FOUND');
    expect(c.message).toBe('Contact does not exist');
  });

  it('429 → RATE_LIMITED + auto_retry', () => {
    const c = classifyBrevoError(429, { message: 'Too many requests' });
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.action.type).toBe('auto_retry');
    expect(c.message).toBe('Too many requests');
  });

  it('400 and 422 → BAD_REQUEST + user_action', () => {
    const c400 = classifyBrevoError(400, { message: 'Invalid email' });
    const c422 = classifyBrevoError(422, { message: 'Unprocessable' });
    expect(c400.code).toBe('BAD_REQUEST');
    expect(c400.action.type).toBe('user_action');
    expect(c422.code).toBe('BAD_REQUEST');
  });

  it('5xx → PROVIDER_ERROR + auto_retry', () => {
    const c = classifyBrevoError(503, { message: 'Service unavailable' });
    expect(c.code).toBe('PROVIDER_ERROR');
    expect(c.action.type).toBe('auto_retry');
    expect(c.message).toBe('Service unavailable');
  });

  it('unmapped status (402) → PROVIDER_ERROR default', () => {
    const c = classifyBrevoError(402, { message: 'Payment required' });
    expect(c.code).toBe('PROVIDER_ERROR');
    expect(c.message).toBe('Payment required');
  });

  it('NEVER tunes the upstream message — only description is curated', () => {
    const literal = 'You exceeded your hourly sending limit';
    const c = classifyBrevoError(429, { message: literal });
    expect(c.message).toBe(literal);
    expect(c.action.description).not.toBe(literal);
  });
});

describe('extractBrevoMessage', () => {
  it('prefers message > error_description > error > code', () => {
    expect(extractBrevoMessage({ message: 'm', error_description: 'ed', error: 'e' }, 'fb')).toBe(
      'm',
    );
    expect(extractBrevoMessage({ error_description: 'ed', error: 'e' }, 'fb')).toBe('ed');
    expect(extractBrevoMessage({ error: 'e', code: 'c' }, 'fb')).toBe('e');
    expect(extractBrevoMessage({ code: 'c' }, 'fb')).toBe('c');
  });

  it('handles plain-text body', () => {
    expect(extractBrevoMessage('Service Unavailable', 'fb')).toBe('Service Unavailable');
  });

  it('falls back when body is empty / non-object', () => {
    expect(extractBrevoMessage('', 'fallback')).toBe('fallback');
    expect(extractBrevoMessage({}, 'fallback')).toBe('fallback');
    expect(extractBrevoMessage(null, 'fallback')).toBe('fallback');
    expect(extractBrevoMessage(undefined, 'fallback')).toBe('fallback');
  });

  it('skips an empty / whitespace message and uses the next field, else fallback', () => {
    expect(extractBrevoMessage({ message: '' }, 'fb')).toBe('fb');
    expect(extractBrevoMessage({ message: '   ' }, 'fb')).toBe('fb');
    expect(extractBrevoMessage({ message: '', error: 'real error' }, 'fb')).toBe('real error');
  });

  it('ignores non-string fields (no JSON leak) and falls back', () => {
    expect(extractBrevoMessage({ message: 42 }, 'fb')).toBe('fb');
    expect(extractBrevoMessage({ message: { nested: 1 } }, 'fb')).toBe('fb');
  });
});

describe('BrevoApiError', () => {
  it('prefixes message with [CODE] and preserves the literal upstream text', () => {
    const err = new BrevoApiError('RATE_LIMITED', 429, 'Too many requests', {
      type: 'auto_retry',
      description: 'retry later',
    });
    expect(err.message).toBe('[RATE_LIMITED] Too many requests');
    expect(err.upstreamMessage).toBe('Too many requests');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
    expect(err.action).toEqual({ type: 'auto_retry', description: 'retry later' });
    expect(err.name).toBe('BrevoApiError');
  });

  it('is an instanceof Error', () => {
    const err = new BrevoApiError('AUTH_INVALID', 401, 'bad key', {
      type: 'user_action',
      description: 'fix it',
    });
    expect(err).toBeInstanceOf(Error);
  });
});
