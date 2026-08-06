/**
 * agent.list-cores defaults to active cores.
 *
 * The consolidation migration DEACTIVATES legacy cores (status:'inactive')
 * rather than deleting them, so they linger in `agent_cores`. The admin list
 * must not surface them by default — it should default the filter to 'active'.
 */
import { describe, expect, it } from 'bun:test';
import { createListCoresHandler } from '../../../../packages/backend/src/handlers/domains/agent/list-cores';

function makeDeps(role = 'admin') {
  const calls: Array<'active' | 'inactive' | undefined> = [];
  const db: any = {
    collection: () => ({ findOne: async () => ({ userId: 'u1', role }) }),
  };
  const modelService: any = {
    listAgentCores: async (status?: 'active' | 'inactive') => {
      calls.push(status);
      return [];
    },
  };
  return { handler: createListCoresHandler(db, modelService), calls };
}

const ctx: any = { userId: 'u1' };

describe('agent.list-cores status filter', () => {
  it('defaults to active when no status is given', async () => {
    const { handler, calls } = makeDeps();
    await handler(ctx, {});
    expect(calls).toEqual(['active']);
  });

  it('honours an explicit inactive filter', async () => {
    const { handler, calls } = makeDeps();
    await handler(ctx, { status: 'inactive' });
    expect(calls).toEqual(['inactive']);
  });

  it('still requires admin', async () => {
    const { handler } = makeDeps('user');
    await expect(handler(ctx, {})).rejects.toThrow(/Admin privileges/);
  });
});
