/**
 * Unit — channel mutation authz (TER-457)
 *
 * `channel.reopen` and `channel.set-private` both gate on the same two checks:
 * the channel must exist (CHANNEL_NOT_FOUND) and the caller must be able to
 * access it (UNAUTHORIZED). A regression letting an outsider reopen or privatise
 * someone else's channel would leak/alter conversations. This asserts both gates
 * for both handlers, plus that the mutation runs once access is granted.
 */

import { describe, expect, it, mock } from 'bun:test';
import { createReopenChannelHandler } from '../../../packages/backend/src/handlers/domains/channel/reopen';
import { createSetPrivateHandler } from '../../../packages/backend/src/handlers/domains/channel/set-private';

const CH = 'ch_1';

function chMgr(over: Record<string, unknown> = {}) {
  return {
    getChannel: async () => ({ channelId: CH, agentId: 'agent_1', status: 'closed', metadata: {}, createdAt: 1, updatedAt: 1, workspaceId: 'work_1' }),
    canAccessChannel: async () => true,
    reopenChannel: mock(async () => undefined),
    setChannelPrivate: mock(async () => undefined),
    enrichChannel: async (c: any) => c,
    ...over,
  } as any;
}
const sessions = { getUserSessions: () => [] } as any;
const pubsub = { broadcastToTopic: mock(() => undefined) } as any;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_THROW';
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
}

const HANDLERS: Array<[string, (cm: any) => (ctx: any, data: any) => Promise<unknown>]> = [
  ['channel.reopen', (cm) => createReopenChannelHandler(cm, sessions)],
  ['channel.set-private', (cm) => createSetPrivateHandler(cm, sessions, pubsub)],
];

describe('channel mutation authz', () => {
  for (const [name, build] of HANDLERS) {
    it(`${name}: CHANNEL_NOT_FOUND when the channel does not exist`, async () => {
      const handler = build(chMgr({ getChannel: async () => null }));
      const code = await codeOf(() => handler({ userId: 'u1' }, { channelId: CH, isPrivate: true }));
      expect(code).toBe('CHANNEL_NOT_FOUND');
    });

    it(`${name}: UNAUTHORIZED when the caller cannot access the channel`, async () => {
      const handler = build(chMgr({ canAccessChannel: async () => false }));
      const code = await codeOf(() => handler({ userId: 'outsider' }, { channelId: CH, isPrivate: true }));
      expect(code).toBe('UNAUTHORIZED');
    });
  }

  it('set-private: runs the mutation once access is granted', async () => {
    const cm = chMgr();
    const handler = createSetPrivateHandler(cm, sessions, pubsub);
    await handler({ userId: 'u1' }, { channelId: CH, isPrivate: true });
    expect(cm.setChannelPrivate).toHaveBeenCalledWith(CH, true);
    expect(pubsub.broadcastToTopic).toHaveBeenCalled();
  });

  it('reopen: reopens the channel once access is granted', async () => {
    const cm = chMgr();
    const handler = createReopenChannelHandler(cm, sessions);
    const res: any = await handler({ userId: 'u1' }, { channelId: CH });
    expect(cm.reopenChannel).toHaveBeenCalledWith(CH);
    expect(res).toEqual({ channelId: CH, status: 'active' });
  });
});
