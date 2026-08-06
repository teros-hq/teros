/**
 * BoardSubscriptionService — dispatch, filtros y shape del evento (TER-472).
 *
 * board-subscription-service no tenía tests. Cubre: notifySubscribers/_dispatch
 * (busca subs por boardId, filtra, emite un ScheduledEvent auto-contenido con
 * shape COMPLETO), _passesFilter (eventTypes/agentIds/columnIds/tags),
 * _shouldWake (wakeUpOn explícito vs DEFAULT_WAKE_UP), y formatEventMessage.
 *
 * Mock fiel: collection con `find({boardId}).toArray()` y un eventInjector que
 * captura el ScheduledEvent exacto.
 */

import { describe, expect, it } from 'bun:test';
import { BoardSubscriptionService } from '../../src/services/board-subscription-service';

type Sub = { channelId: string; boardId: string; filter: any };

function makeService(subs: Sub[]) {
  const injected: any[] = [];
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
  return { svc, injected };
}

function event(over: Partial<any> = {}): any {
  return {
    eventType: over.eventType ?? 'board.task_moved',
    boardId: over.boardId ?? 'board_1',
    formattedMessage: over.formattedMessage ?? 'msg',
    payload: over.payload ?? {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// _dispatch — shape del ScheduledEvent (await directo, sin la carrera fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

describe('BoardSubscriptionService._dispatch', () => {
  it('emite un ScheduledEvent auto-contenido con shape COMPLETO al subscriber', async () => {
    const { svc, injected } = makeService([{ channelId: 'ch_1', boardId: 'board_1', filter: {} }]);

    await (svc as any)._dispatch(
      'board_1',
      event({
        eventType: 'board.task_progress_note',
        formattedMessage: 'Nota: avance',
        payload: { taskId: 't1', noteText: 'avance', assignedAgentId: 'agent_1' },
      }),
    );

    expect(injected).toEqual([
      {
        channelId: 'ch_1',
        message: 'Nota: avance',
        eventType: 'task_update',
        wakeUpAgent: true, // progress_note despierta por DEFAULT_WAKE_UP
        metadata: {
          source: 'board_subscription',
          boardEventType: 'board.task_progress_note',
          boardId: 'board_1',
          taskId: 't1',
          noteText: 'avance',
          assignedAgentId: 'agent_1',
        },
      },
    ]);
  });

  it('sin eventInjector configurado → no lanza, no emite', async () => {
    const db = { collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as any;
    const svc = new BoardSubscriptionService(db);
    await expect((svc as any)._dispatch('board_1', event())).resolves.toBeUndefined();
  });

  it('sin subscribers para el board → no emite', async () => {
    const { svc, injected } = makeService([{ channelId: 'ch_x', boardId: 'OTRO', filter: {} }]);
    await (svc as any)._dispatch('board_1', event());
    expect(injected).toEqual([]);
  });

  it('entrega a TODOS los subscribers que pasan el filtro', async () => {
    const { svc, injected } = makeService([
      { channelId: 'ch_1', boardId: 'board_1', filter: {} },
      { channelId: 'ch_2', boardId: 'board_1', filter: {} },
    ]);
    await (svc as any)._dispatch('board_1', event());
    expect(injected.map((e) => e.channelId).sort()).toEqual(['ch_1', 'ch_2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// notifySubscribers — fire-and-forget público
// ─────────────────────────────────────────────────────────────────────────────

describe('BoardSubscriptionService.notifySubscribers', () => {
  it('es fire-and-forget (void) y acaba emitiendo al subscriber', async () => {
    const { svc, injected } = makeService([{ channelId: 'ch_1', boardId: 'board_1', filter: {} }]);
    const ret = svc.notifySubscribers('board_1', event());
    expect(ret).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10)); // dejar resolver el _dispatch async
    expect(injected.length).toBe(1);
  });

  it('un eventInjector que lanza NO propaga al caller', async () => {
    const db = {
      collection: () => ({
        find: () => ({ toArray: async () => [{ channelId: 'ch_1', boardId: 'board_1', filter: {} }] }),
      }),
    } as any;
    const svc = new BoardSubscriptionService(db);
    svc.setEventInjector(async () => {
      throw new Error('injector boom');
    });
    expect(() => svc.notifySubscribers('board_1', event())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _passesFilter
// ─────────────────────────────────────────────────────────────────────────────

describe('_passesFilter', () => {
  const { svc } = makeService([]);
  const passes = (filter: any, ev: any) => (svc as any)._passesFilter(filter, ev);

  it('filtro vacío pasa siempre', () => {
    expect(passes({}, event())).toBe(true);
  });

  it('eventTypes: solo los listados', () => {
    expect(passes({ eventTypes: ['board.task_moved'] }, event({ eventType: 'board.task_moved' }))).toBe(true);
    expect(passes({ eventTypes: ['board.task_created'] }, event({ eventType: 'board.task_moved' }))).toBe(false);
  });

  it('agentIds: matchea payload.assignedAgentId', () => {
    expect(passes({ agentIds: ['agent_1'] }, event({ payload: { assignedAgentId: 'agent_1' } }))).toBe(true);
    expect(passes({ agentIds: ['agent_1'] }, event({ payload: { assignedAgentId: 'agent_2' } }))).toBe(false);
    expect(passes({ agentIds: ['agent_1'] }, event({ payload: {} }))).toBe(false);
  });

  it('columnIds: matchea toColumnId (move) o columnId', () => {
    expect(passes({ columnIds: ['col_done'] }, event({ payload: { toColumnId: 'col_done', columnId: 'col_todo' } }))).toBe(true);
    expect(passes({ columnIds: ['col_todo'] }, event({ payload: { columnId: 'col_todo' } }))).toBe(true);
    expect(passes({ columnIds: ['col_x'] }, event({ payload: { columnId: 'col_todo' } }))).toBe(false);
  });

  it('tags: la tarea debe tener TODOS los tags del filtro (AND)', () => {
    expect(passes({ tags: ['a', 'b'] }, event({ payload: { tags: ['a', 'b', 'c'] } }))).toBe(true);
    expect(passes({ tags: ['a', 'b'] }, event({ payload: { tags: ['a'] } }))).toBe(false);
    expect(passes({ tags: ['a'] }, event({ payload: {} }))).toBe(false);
  });

  it('combina filtros (AND entre dimensiones)', () => {
    const filter = { eventTypes: ['board.task_moved'], agentIds: ['agent_1'] };
    expect(passes(filter, event({ eventType: 'board.task_moved', payload: { assignedAgentId: 'agent_1' } }))).toBe(true);
    expect(passes(filter, event({ eventType: 'board.task_moved', payload: { assignedAgentId: 'agent_2' } }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _shouldWake
// ─────────────────────────────────────────────────────────────────────────────

describe('_shouldWake', () => {
  const { svc } = makeService([]);
  const wake = (filter: any, type: any) => (svc as any)._shouldWake(filter, type);

  it('wakeUpOn explícito gana sobre el default', () => {
    expect(wake({ wakeUpOn: ['board.task_moved'] }, 'board.task_moved')).toBe(true);
    expect(wake({ wakeUpOn: ['board.task_created'] }, 'board.task_moved')).toBe(false);
  });

  it('sin wakeUpOn: usa DEFAULT_WAKE_UP (solo progress_note despierta)', () => {
    expect(wake({}, 'board.task_progress_note')).toBe(true);
    expect(wake({}, 'board.task_moved')).toBe(false);
    expect(wake({}, 'board.task_created')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatEventMessage (static)
// ─────────────────────────────────────────────────────────────────────────────

describe('BoardSubscriptionService.formatEventMessage', () => {
  it('task_moved incluye columnas origen/destino y agente', () => {
    const msg = BoardSubscriptionService.formatEventMessage({
      eventType: 'board.task_moved',
      boardId: 'b1',
      payload: { taskTitle: 'Mi tarea', fromColumnName: 'Todo', toColumnName: 'Done', assignedAgentId: 'agent_1' },
    });
    expect(msg).toContain('task_moved');
    expect(msg).toContain('"Mi tarea"');
    expect(msg).toContain('from "Todo" to "Done"');
    expect(msg).toContain('agent_1');
  });

  it('progress_note incluye el texto de la nota', () => {
    const msg = BoardSubscriptionService.formatEventMessage({
      eventType: 'board.task_progress_note',
      boardId: 'b1',
      payload: { taskId: 't1', noteText: 'avancé el 80%' },
    });
    expect(msg).toContain('avancé el 80%');
  });

  it('usa taskId como referencia cuando no hay taskTitle', () => {
    const msg = BoardSubscriptionService.formatEventMessage({
      eventType: 'board.task_updated',
      boardId: 'b1',
      payload: { taskId: 'task_42' },
    });
    expect(msg).toContain('task_42');
  });
});
