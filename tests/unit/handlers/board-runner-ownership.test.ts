/**
 * Unit — runner self-task ownership guard (TER-457)
 *
 * The board runner handlers (cancel/block/complete/move-my-task) let an agent
 * act on its OWN tasks by slug, without exposing columnIds. The security
 * invariant: an agent must never mutate a task assigned to a different agent.
 * Each handler enforces `task.assignedAgentId === agentId` and otherwise throws
 * FORBIDDEN. This drives every handler with a foreign task and asserts the gate.
 */

import { describe, expect, it } from 'bun:test';
import { createBlockMyTaskHandler } from '../../../packages/backend/src/handlers/domains/board/block-my-task';
import { createCancelMyTaskHandler } from '../../../packages/backend/src/handlers/domains/board/cancel-my-task';
import { createCompleteMyTaskHandler } from '../../../packages/backend/src/handlers/domains/board/complete-my-task';
import { createMoveMyTaskHandler } from '../../../packages/backend/src/handlers/domains/board/move-my-task';

const ME = 'agent_me';
const OTHER = 'agent_other';

// Superset of the fields the four handlers require; each picks what it needs.
const DATA = { taskId: 'task_1', agentId: ME, reason: 'because', columnId: 'col_1', position: 0 };

/** Build a handler with a boardService whose getTask returns `task`; other deps are inert. */
function makeHandler(factory: (...a: any[]) => any, task: unknown) {
  const boardService = { getTask: async () => task } as any;
  const stub = new Proxy({}, { get: () => async () => undefined }) as any;
  // Pass boardService first, then enough inert stubs to satisfy every factory arity.
  return factory(boardService, stub, stub, stub, stub, stub, stub);
}

const HANDLERS: Array<[string, (...a: any[]) => any]> = [
  ['cancel-my-task', createCancelMyTaskHandler],
  ['block-my-task', createBlockMyTaskHandler],
  ['complete-my-task', createCompleteMyTaskHandler],
  ['move-my-task', createMoveMyTaskHandler],
];

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_THROW';
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
}

describe('runner ownership guard — no tocar tareas ajenas', () => {
  for (const [name, factory] of HANDLERS) {
    it(`${name}: rejects a task assigned to another agent with FORBIDDEN`, async () => {
      const handler = makeHandler(factory, { taskId: 'task_1', assignedAgentId: OTHER, boardId: 'board_1' });
      const code = await codeOf(() => handler({ userId: 'user_1' }, DATA));
      expect(code).toBe('FORBIDDEN');
    });

    it(`${name}: returns NOT_FOUND when the task does not exist`, async () => {
      const handler = makeHandler(factory, null);
      const code = await codeOf(() => handler({ userId: 'user_1' }, DATA));
      expect(code).toBe('NOT_FOUND');
    });

    it(`${name}: rejects MISSING_FIELDS when agentId is absent`, async () => {
      const handler = makeHandler(factory, { taskId: 'task_1', assignedAgentId: ME });
      const code = await codeOf(() => handler({ userId: 'user_1' }, { taskId: 'task_1' }));
      expect(code).toBe('MISSING_FIELDS');
    });
  }
});
