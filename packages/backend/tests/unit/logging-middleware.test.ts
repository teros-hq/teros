import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { loggingMiddleware } from '../../src/ws-framework/logging-middleware';

const baseCtx = { userId: 'user_1', sessionId: 'sess_1' };

describe('loggingMiddleware', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should call next() and return its result', async () => {
    const next = mock(async () => ({ ok: true }));

    const result = await loggingMiddleware(baseCtx, 'profile.get', {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it('should log success with action, userId, and duration', async () => {
    const next = mock(async () => ({}));

    await loggingMiddleware(baseCtx, 'profile.get', {}, next);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logMessage = consoleLogSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('✅');
    expect(logMessage).toContain('profile.get');
    expect(logMessage).toContain('user_1');
    expect(logMessage).toMatch(/\d+ms/);
  });

  it('should log error and re-throw when next() throws', async () => {
    const error = new Error('Handler exploded');
    const next = mock(async () => { throw error; });

    await expect(
      loggingMiddleware(baseCtx, 'test.fail', {}, next),
    ).rejects.toThrow('Handler exploded');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logMessage = consoleErrorSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('❌');
    expect(logMessage).toContain('test.fail');
    expect(logMessage).toContain('user_1');
    expect(logMessage).toContain('Handler exploded');
  });

  it('should not interfere with the data passed through', async () => {
    const inputData = { key: 'value', nested: { a: 1 } };
    const next = mock(async () => 'result');

    await loggingMiddleware(baseCtx, 'test.data', inputData, next);

    // Middleware should not modify data — just pass through
    expect(next).toHaveBeenCalledTimes(1);
  });
});
