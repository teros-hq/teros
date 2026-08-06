import type { McaExecutionContext } from '@teros/shared';
import { generateMessageId } from '@teros/shared';

export function createExecutionContext(
  overrides?: Partial<McaExecutionContext>,
): McaExecutionContext {
  return {
    userId: 'user:test_user',
    appId: 'app:test_app',
    mcaId: overrides?.mcaId ?? 'mca.test',
    channelId: 'channel:test',
    agentId: 'agent:test',
    workspaceId: 'workspace:test',
    requestId: generateMessageId(),
    callbackUrl: 'http://localhost:9900',
    ...overrides,
  };
}

export function createCallbackUrl(host: string = 'localhost', port: number = 9900): string {
  return `http://${host}:${port}`;
}
