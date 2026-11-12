/**
 * board-event-emitters — unit tests (fb_d211b16343bd3034).
 *
 * These builders are the payloads the MCA inline paths now emit (they
 * previously emitted nothing — the bug). Invariants:
 *   1. Each emitter fires notifySubscribers with the exact eventType and a
 *      payload that mirrors the corresponding WS domain handler.
 *   2. actorAgentId / actorUserId travel in the payload (self-wake guard).
 *   3. assignedAgentId null → undefined (not null) in the payload.
 *   4. formattedMessage is derived from the payload (formatEventMessage).
 *
 * The BoardSubscriptionService is a real instance over a mock db whose
 * notifySubscribers is instrumented — we assert the BoardEvent it received.
 */

import { describe, expect, it } from 'bun:test';
import { BoardSubscriptionService } from '../../src/services/board-subscription-service';
import {
  emitDependencyAdded,
  emitDependencyRemoved,
  emitTaskArchived,
  emitTaskAssigned,
  emitTaskCreated,
  emitTaskMoved,
  emitTaskProgressNote,
  emitTaskUpdated,
} from '../../src/services/board-event-emitters';

function makeCapturingService() {
  const events: any[] = [];
  const db = { collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as any;
  const svc = new BoardSubscriptionService(db);
  // Instrument notifySubscribers instead of the injector: we want the exact
  // BoardEvent the emitter built (eventType + payload + formattedMessage),
  // not the per-channel ScheduledEvent.
  (svc as any).notifySubscribers = (boardId: string, event: any) => {
    events.push({ boardId, ...event });
  };
  return { svc, events };
}

const task = {
  taskId: 'task_1',
  title: 'Fix login bug',
  boardId: 'board_1',
  assignedAgentId: 'agent_nira',
  tags: ['bug', 'auth'],
  columnId: 'col_inprogress',
};

describe('board-event-emitters', () => {
  it('emitTaskProgressNote — THE bug case: eventType + payload mirror add-my-progress-note.ts', () => {
    const { svc, events } = makeCapturingService();
    emitTaskProgressNote(svc, task, 'avance 50%', { actorAgentId: 'agent_nira' });

    expect(events).toHaveLength(1);
    expect(events[0].boardId).toBe('board_1');
    expect(events[0].eventType).toBe('board.task_progress_note');
    expect(events[0].payload).toEqual({
      taskId: 'task_1',
      taskTitle: 'Fix login bug',
      assignedAgentId: 'agent_nira',
      tags: ['bug', 'auth'],
      columnId: 'col_inprogress',
      noteText: 'avance 50%',
      actorAgentId: 'agent_nira',
    });
    // formattedMessage derived from the payload — includes the note text
    expect(events[0].formattedMessage).toContain('avance 50%');
    expect(events[0].formattedMessage).toContain('Fix login bug');
  });

  it('emitTaskMoved — payload mirrors move-task.ts (from/to columns + destination as columnId)', () => {
    const { svc, events } = makeCapturingService();
    emitTaskMoved(
      svc,
      task,
      {
        fromColumnId: 'col_todo',
        fromColumnName: 'To Do',
        toColumnId: 'col_done',
        toColumnName: 'Done',
      },
      { actorAgentId: 'agent_nira' },
    );

    expect(events[0].eventType).toBe('board.task_moved');
    expect(events[0].payload).toEqual({
      taskId: 'task_1',
      taskTitle: 'Fix login bug',
      assignedAgentId: 'agent_nira',
      tags: ['bug', 'auth'],
      fromColumnId: 'col_todo',
      fromColumnName: 'To Do',
      toColumnId: 'col_done',
      toColumnName: 'Done',
      columnId: 'col_done',
      actorAgentId: 'agent_nira',
    });
    expect(events[0].formattedMessage).toContain('from "To Do" to "Done"');
  });

  it('emitTaskAssigned — payload mirrors assign-task.ts', () => {
    const { svc, events } = makeCapturingService();
    emitTaskAssigned(svc, task, { actorUserId: 'user_pablo' });

    expect(events[0].eventType).toBe('board.task_assigned');
    expect(events[0].payload).toEqual({
      taskId: 'task_1',
      taskTitle: 'Fix login bug',
      assignedAgentId: 'agent_nira',
      tags: ['bug', 'auth'],
      columnId: 'col_inprogress',
      actorUserId: 'user_pablo',
    });
    expect(events[0].payload.actorAgentId).toBeUndefined();
  });

  it('emitTaskUpdated — payload mirrors update-task.ts', () => {
    const { svc, events } = makeCapturingService();
    emitTaskUpdated(svc, task, { actorAgentId: 'agent_alice' });

    expect(events[0].eventType).toBe('board.task_updated');
    expect(events[0].payload.taskId).toBe('task_1');
    expect(events[0].payload.actorAgentId).toBe('agent_alice');
  });

  it('emitTaskCreated — payload mirrors create-task.ts (includes columnName)', () => {
    const { svc, events } = makeCapturingService();
    emitTaskCreated(svc, task, 'Backlog', { actorAgentId: 'agent_alice' });

    expect(events[0].eventType).toBe('board.task_created');
    expect(events[0].payload.columnName).toBe('Backlog');
    expect(events[0].formattedMessage).toContain('Backlog');
  });

  it('emitTaskArchived — payload mirrors archive-task.ts (archived flag)', () => {
    const { svc, events } = makeCapturingService();
    emitTaskArchived(svc, task, true, { actorAgentId: 'agent_alice' });

    expect(events[0].eventType).toBe('board.task_archived');
    expect(events[0].payload.archived).toBe(true);
    expect(events[0].formattedMessage).toContain('archived');
  });

  it('emitDependencyAdded / emitDependencyRemoved — payload mirrors add/remove-dependency.ts', () => {
    const { svc, events } = makeCapturingService();
    emitDependencyAdded(svc, task, 'task_2', { actorAgentId: 'agent_alice' });
    emitDependencyRemoved(svc, task, 'task_2', { actorAgentId: 'agent_alice' });

    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('board.dependency_added');
    expect(events[0].payload.dependsOnTaskId).toBe('task_2');
    expect(events[1].eventType).toBe('board.dependency_removed');
    expect(events[1].payload.dependsOnTaskId).toBe('task_2');
  });

  it('assignedAgentId null → undefined en el payload (no null en eventos)', () => {
    const { svc, events } = makeCapturingService();
    const unassigned = { ...task, assignedAgentId: null as unknown as string };
    emitTaskUpdated(svc, unassigned, { actorAgentId: 'agent_alice' });
    expect(events[0].payload.assignedAgentId).toBeUndefined();
  });

  it('los payloads pasan el matcher de una suscripción con taskIds + eventTypes (el filtro del bug)', async () => {
    // Integración mínima: emitter → real notifySubscribers → real _dispatch →
    // matcher con el filtro EXACTO de la suscripción de Alice.
    const injected: any[] = [];
    const subs = [
      {
        channelId: 'ch_alice',
        boardId: 'board_1',
        filter: {
          eventTypes: ['board.task_progress_note', 'board.task_moved', 'board.task_updated'],
          taskIds: ['task_1'],
        },
      },
    ];
    const db = {
      collection: () => ({
        find: (filter: any) => ({
          toArray: async () => subs.filter((s) => s.boardId === filter.boardId),
        }),
      }),
    } as any;
    const svc = new BoardSubscriptionService(db);
    svc.setEventInjector(async (e: any) => {
      injected.push(e);
      return { success: true };
    });

    emitTaskProgressNote(svc, task, 'avance 50%', { actorAgentId: 'agent_nira' });
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget

    expect(injected).toHaveLength(1);
    expect(injected[0].channelId).toBe('ch_alice');
    expect(injected[0].wakeUpAgent).toBe(true); // progress_note despierta por defecto
    expect(injected[0].metadata.boardEventType).toBe('board.task_progress_note');
    expect(injected[0].metadata.taskId).toBe('task_1');
    expect(injected[0].metadata.actorAgentId).toBe('agent_nira'); // self-wake guard
  });

  it('un evento para OTRA task NO despierta la suscripción con taskIds', async () => {
    const injected: any[] = [];
    const subs = [
      { channelId: 'ch_alice', boardId: 'board_1', filter: { taskIds: ['task_1'] } },
    ];
    const db = {
      collection: () => ({
        find: (filter: any) => ({
          toArray: async () => subs.filter((s) => s.boardId === filter.boardId),
        }),
      }),
    } as any;
    const svc = new BoardSubscriptionService(db);
    svc.setEventInjector(async (e: any) => {
      injected.push(e);
      return { success: true };
    });

    const otherTask = { ...task, taskId: 'task_999' };
    emitTaskProgressNote(svc, otherTask, 'otra tarea', { actorAgentId: 'agent_nira' });
    await new Promise((r) => setTimeout(r, 10));

    expect(injected).toHaveLength(0);
  });
});
