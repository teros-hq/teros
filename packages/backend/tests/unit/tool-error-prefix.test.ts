import { describe, expect, it } from 'bun:test';
import { executeToolViaHttp } from '../../src/services/mca-manager.tools';

function run(message: string) {
  const ctx: any = {
    mcas: new Map(),
    httpClients: new Map(),
    config: { serverPort: 10001 },
    containerManager: { touch: () => {} },
    containerBackendHost: 'localhost',
  };
  const managed: any = { appId: 'app_gh', mcaId: 'mca.github', containerKey: 'app_gh', lastUsed: new Date() };
  const httpClient: any = { callTool: async () => ({ success: false, error: { code: 'INTERNAL_ERROR', message } }) };
  return executeToolViaHttp(ctx, managed, 'get-repo', {}, httpClient);
}

describe('classified MCA errors are not prefixed with a second "Error:"', () => {
  it.each([
    '[NOT_FOUND] Not Found\nWhat to do: check the owner and repository.',
    '[GIT_WORKFLOW_PERMISSION] GitHub refused the push.\nWhat to do: accept the permission.',
  ])('%s', async (message) => {
    const result = await run(message);
    expect(result.isError).toBe(true);
    expect(result.output).toBe(message);
  });

  it('an unclassified error keeps the Error: prefix', async () => {
    const result = await run('fetch failed');
    expect(result.output).toBe('Error: fetch failed');
  });
});
