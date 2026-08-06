import { describe, expect, it } from 'bun:test';
import { executeToolViaHttp } from '../../src/services/mca-manager.tools';

/**
 * Validates that executeToolViaHttp rewrites caller-aborted errors into a
 * semantic message instead of leaking HttpClient transport details
 * ("Request aborted by caller: http://...") to the LLM.
 */
describe('executeToolViaHttp cancellation classifier', () => {
  function buildCtx() {
    return {
      mcas: new Map(),
      httpClients: new Map(),
      config: { serverPort: 10001 },
      containerManager: { touch: () => {} },
      containerBackendHost: 'localhost',
    } as any;
  }

  const managed = {
    appId: 'app_test',
    mcaId: 'mca.teros.bash',
    containerKey: 'mca-teros-bash-test',
    lastUsed: new Date(),
  } as any;

  function buildHttpClient(behavior: 'abort' | 'plain-error' | 'success') {
    return {
      callTool: async () => {
        if (behavior === 'abort') {
          const err: any = new Error('Request aborted by caller: http://localhost:13097/tools/call');
          err.code = 'ABORTED';
          err.statusCode = 499;
          throw err;
        }
        if (behavior === 'plain-error') {
          throw new Error('connect ECONNREFUSED');
        }
        return { success: true, result: 'ok' };
      },
    } as any;
  }

  it('rewrites ABORTED to a semantic message without URL leakage', async () => {
    const result = await executeToolViaHttp(
      buildCtx(),
      managed,
      'bash',
      {},
      buildHttpClient('abort'),
    );
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('http://');
    expect(result.output).not.toContain('Request aborted by caller');
    expect(result.output.toLowerCase()).toContain('cancelled');
    expect(result.output.toLowerCase()).toContain('side effect');
  });

  it('passes through non-aborted errors as-is', async () => {
    const result = await executeToolViaHttp(
      buildCtx(),
      managed,
      'bash',
      {},
      buildHttpClient('plain-error'),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('ECONNREFUSED');
  });

  it('returns success output when callTool succeeds', async () => {
    const result = await executeToolViaHttp(
      buildCtx(),
      managed,
      'bash',
      {},
      buildHttpClient('success'),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('ok');
  });
});
