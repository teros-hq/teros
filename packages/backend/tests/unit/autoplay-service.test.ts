/**
 * AutoplayService — slot rules + selección de tasks (TER-472).
 *
 * autoplay-service no tenía tests. Cubre: setSlots/setPlayEnabled (reglas de
 * slots/play) y scheduleAgentTasks (NO agenda tareas ajenas, respeta slots
 * disponibles = slots - running, dependency guard, stuck-rewake con prioridad).
 *
 * El dispatch real (_startNewTask/_rewakeTask: crean canal + llaman LLM) se
 * espía con `as any` para verificar QUÉ tasks se procesan y CUÁNTAS, sin tocar
 * canales/LLM. Db en memoria con matcher que evalúa los operadores usados.
 */

import { describe, expect, it, mock } from 'bun:test';
import { AutoplayService } from '../../src/services/autoplay-service';

// Matcher fiel del subconjunto de query-language usado por autoplay-service.
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond as any).every(([op, v]) => {
        if (op === '$ne') return doc[k] !== v;
        if (op === '$gt') return doc[k] > (v as any);
        if (op === '$in') return (v as any[]).includes(doc[k]);
        if (op === '$exists') return (doc[k] !== undefined) === v;
        throw new Error(`op no soportado: ${op}`);
      });
    }
    return doc[k] === cond;
  });
}

function makeCol(docs: any[]) {
  const updates: any[] = [];
  return {
    updates,
    findOne: async (f: any) => docs.find((d) => matches(d, f)) ?? null,
    find: (f: any) => ({ toArray: async () => docs.filter((d) => matches(d, f)) }),
    countDocuments: async (f: any) => docs.filter((d) => matches(d, f)).length,
    findOneAndUpdate: async (f: any, upd: any, opts: any) => {
      updates.push({ filter: f, update: upd, opts });
      let doc = docs.find((d) => matches(d, f));
      if (!doc && opts?.upsert) {
        doc = { ...f };
        docs.push(doc);
      }
      if (doc) Object.assign(doc, upd.$set ?? {});
      return doc ?? null;
    },
  };
}

function makeService(collections: Record<string, any[]>) {
  const cols: Record<string, ReturnType<typeof makeCol>> = {};
  const db = {
    collection: (name: string) => {
      if (!cols[name]) cols[name] = makeCol(collections[name] ?? []);
      return cols[name];
    },
  } as any;
  const svc = new AutoplayService(db, {} as any, {} as any);
  const started: any[] = [];
  const rewoken: any[] = [];
  (svc as any)._startNewTask = mock(async (task: any) => started.push(task.taskId));
  (svc as any)._rewakeTask = mock(async (task: any) => rewoken.push(task.taskId));
  return { svc, cols, started, rewoken };
}

const BOARD = {
  boardId: 'board_1',
  columns: [
    { columnId: 'c_todo', slug: 'todo' },
    { columnId: 'c_prog', slug: 'in_progress' },
    { columnId: 'c_done', slug: 'done' },
  ],
};
const PROJECT = { projectId: 'proj_1', boardId: 'board_1' };
const REL = { projectId: 'proj_1', agentId: 'agent_1', slots: 2, playEnabled: true };

const task = (over: Partial<any>): any => ({
  taskId: over.taskId,
  boardId: 'board_1',
  assignedAgentId: 'agent_1',
  columnId: 'c_todo',
  archived: false,
  running: false,
  dependencies: [],
  priority: 'medium',
  createdAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// setSlots / setPlayEnabled — reglas de slots
// ─────────────────────────────────────────────────────────────────────────────

describe('AutoplayService.setAgentSlots', () => {
  it('rechaza slots negativos', async () => {
    const { svc } = makeService({});
    await expect(svc.setAgentSlots('proj_1', 'agent_1', -1)).rejects.toThrow('slots must be >= 0');
  });

  it('persiste los slots', async () => {
    const { svc, cols } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 1, playEnabled: false }] });
    await svc.setAgentSlots('proj_1', 'agent_1', 3);
    expect(cols.agent_project_relationships.updates[0].update.$set.slots).toBe(3);
  });

  it('slots=0 con play activo → también desactiva play', async () => {
    const { svc, cols } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 2, playEnabled: true }] });
    await svc.setAgentSlots('proj_1', 'agent_1', 0);
    const set = cols.agent_project_relationships.updates[0].update.$set;
    expect(set.slots).toBe(0);
    expect(set.playEnabled).toBe(false);
  });

  it('slots=0 con play ya inactivo → no toca playEnabled', async () => {
    const { svc, cols } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 2, playEnabled: false }] });
    await svc.setAgentSlots('proj_1', 'agent_1', 0);
    expect(cols.agent_project_relationships.updates[0].update.$set.playEnabled).toBeUndefined();
  });
});

describe('AutoplayService.setAgentPlay', () => {
  it('rechaza activar play con 0 slots', async () => {
    const { svc } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 0, playEnabled: false }] });
    await expect(svc.setAgentPlay('proj_1', 'agent_1', true)).rejects.toThrow('INVALID_STATE');
  });

  it('permite activar play con slots > 0', async () => {
    const { svc } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 2, playEnabled: false }] });
    await expect(svc.setAgentPlay('proj_1', 'agent_1', true)).resolves.toBeDefined();
  });

  it('permite desactivar play sin mirar slots', async () => {
    const { svc } = makeService({ agent_project_relationships: [{ projectId: 'proj_1', agentId: 'agent_1', slots: 0, playEnabled: true }] });
    await expect(svc.setAgentPlay('proj_1', 'agent_1', false)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scheduleAgentTasks — no-op guards
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleAgentTasks — no-op conditions', () => {
  it('no hace nada si no hay relación', async () => {
    const { svc, started, rewoken } = makeService({ projects: [PROJECT], boards: [BOARD] });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual([]);
    expect(rewoken).toEqual([]);
  });

  it('no hace nada si playEnabled=false', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [{ ...REL, playEnabled: false }],
      projects: [PROJECT], boards: [BOARD],
      tasks: [task({ taskId: 't1' })],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual([]);
  });

  it('no hace nada si slots=0', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [{ ...REL, slots: 0 }],
      projects: [PROJECT], boards: [BOARD],
      tasks: [task({ taskId: 't1' })],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scheduleAgentTasks — selección
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleAgentTasks — selección de tasks', () => {
  it('inicia una task elegible (Todo, sin deps, del agente)', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [REL],
      projects: [PROJECT], boards: [BOARD],
      tasks: [task({ taskId: 't1' })],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual(['t1']);
  });

  it('NO agenda tareas de OTRO agente ni de otro board (no cross)', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [REL],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_mine' }),
        task({ taskId: 't_other_agent', assignedAgentId: 'agent_2' }),
        task({ taskId: 't_other_board', boardId: 'board_99' }),
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual(['t_mine']);
  });

  it('respeta los slots disponibles (slots - running)', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [{ ...REL, slots: 2 }],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_running', running: true, columnId: 'c_prog' }), // ocupa 1 slot
        task({ taskId: 't1', priority: 'high', createdAt: '2026-06-01T00:00:00Z' }),
        task({ taskId: 't2', priority: 'low', createdAt: '2026-06-02T00:00:00Z' }),
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    // 2 slots - 1 running = 1 disponible → solo arranca la de mayor prioridad
    expect(started).toEqual(['t1']);
  });

  it('dependency guard: no inicia si una dependencia no está en Done', async () => {
    // d1 es de OTRO agente (no candidata para agent_1) y NO está en Done.
    const { svc, started } = makeService({
      agent_project_relationships: [REL],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_dep', dependencies: ['d1'] }),
        task({ taskId: 'd1', assignedAgentId: 'agent_2', columnId: 'c_todo' }), // dep NO resuelta
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual([]);
  });

  it('dependency guard: con MÚLTIPLES deps, TODAS deben estar en Done (every, no some)', async () => {
    // d1 resuelta, d2 NO → la task NO debe iniciarse. Caza every-vs-some
    // (con una sola dep no se distinguen).
    const { svc, started } = makeService({
      agent_project_relationships: [REL],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_dep', dependencies: ['d1', 'd2'] }),
        task({ taskId: 'd1', assignedAgentId: 'agent_2', columnId: 'c_done' }),
        task({ taskId: 'd2', assignedAgentId: 'agent_2', columnId: 'c_todo' }),
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual([]);
  });

  it('dependency guard: inicia cuando la dependencia está en Done', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [REL],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_dep', dependencies: ['d1'] }),
        task({ taskId: 'd1', assignedAgentId: 'agent_2', columnId: 'c_done' }), // resuelta
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started).toEqual(['t_dep']);
  });

  it('re-wake de stuck tasks tiene prioridad sobre arrancar nuevas', async () => {
    const { svc, started, rewoken } = makeService({
      agent_project_relationships: [{ ...REL, slots: 1 }],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_stuck', columnId: 'c_prog', channelId: 'ch_1', running: false }),
        task({ taskId: 't_new' }),
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    // 1 slot disponible → la stuck (rewake) va primero, la nueva no entra
    expect(rewoken).toEqual(['t_stuck']);
    expect(started).toEqual([]);
  });

  it('ordena por prioridad (urgent/high antes que low) cuando hay slots', async () => {
    const { svc, started } = makeService({
      agent_project_relationships: [{ ...REL, slots: 5 }],
      projects: [PROJECT], boards: [BOARD],
      tasks: [
        task({ taskId: 't_low', priority: 'low' }),
        task({ taskId: 't_urgent', priority: 'urgent' }),
        task({ taskId: 't_med', priority: 'medium' }),
      ],
    });
    await svc.scheduleAgentTasks('proj_1', 'agent_1');
    expect(started[0]).toBe('t_urgent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _startNewTask — billing attribution + triggerKind (TER-650/G3)
// ─────────────────────────────────────────────────────────────────────────────

/** Richer fakes to exercise the REAL _startNewTask body (not the spy). */
function makeG3Service(opts: { workspaceOwnerId?: string }) {
  const cols: Record<string, any[]> = {
    boards: [BOARD],
    tasks: [task({ taskId: 't1', columnId: 'c_todo' })],
    workspaces: opts.workspaceOwnerId
      ? [{ workspaceId: 'work_1', ownerId: opts.workspaceOwnerId }]
      : [{ workspaceId: 'work_1' }], // no ownerId
  }
  const taskUpdates: any[] = []
  const db = {
    collection: (name: string) => ({
      findOne: async (f: any) => (cols[name] ?? []).find((d) => matches(d, f)) ?? null,
      find: (_f: any) => ({
        sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
      }),
      updateOne: async (f: any, u: any) => {
        if (name === 'tasks') taskUpdates.push({ filter: f, update: u })
        const d = (cols[name] ?? []).find((x) => matches(x, f))
        if (d) Object.assign(d, u.$set ?? {})
      },
    }),
  } as any
  const createChannelCalls: any[] = []
  const channelManager = {
    createChannel: async (userId: string, agentId: string, _o: any, _e: any) => {
      createChannelCalls.push({ userId, agentId })
      return { channelId: 'ch_new' }
    },
    // _startNewTask persists the initial message before waking the agent.
    createMessageId: () => 'msg_test_1',
    getUserSender: async () => null,
    saveMessage: async () => {},
  } as any
  const pubSub = { broadcastToTopic: () => {} } as any
  const svc = new AutoplayService(db, pubSub, channelManager)
  const wakeCalls: any[] = []
  svc.setWakeUpCallback(async (channelId, agentId, text, triggerKind) => {
    wakeCalls.push({ channelId, agentId, text, triggerKind })
  })
  return { svc, createChannelCalls, wakeCalls, taskUpdates }
}

describe('_startNewTask — attribution (TER-650/G3)', () => {
  it('crea el canal con el workspace.ownerId (no "system")', async () => {
    const { svc, createChannelCalls } = makeG3Service({ workspaceOwnerId: 'user_owner' })
    await (svc as any)._startNewTask(task({ taskId: 't1' }), 'agent_1', 'board_1', 'proj_1', 'work_1')
    expect(createChannelCalls).toHaveLength(1)
    // Bill a real user, never the synthetic 'system'.
    expect(createChannelCalls[0].userId).toBe('user_owner')
    expect(createChannelCalls[0].userId).not.toBe('system')
  })

  it('despierta al agente con triggerKind="autorun"', async () => {
    const { svc, wakeCalls } = makeG3Service({ workspaceOwnerId: 'user_owner' })
    await (svc as any)._startNewTask(task({ taskId: 't1' }), 'agent_1', 'board_1', 'proj_1', 'work_1')
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0].triggerKind).toBe('autorun')
  })

  it('fail-loud si el workspace no tiene ownerId: NO crea canal ni mueve la task', async () => {
    const { svc, createChannelCalls, wakeCalls } = makeG3Service({ workspaceOwnerId: undefined })
    await (svc as any)._startNewTask(task({ taskId: 't1' }), 'agent_1', 'board_1', 'proj_1', 'work_1')
    // Sin owner no se factura a 'system' — se sale limpio antes de mutar nada.
    expect(createChannelCalls).toEqual([])
    expect(wakeCalls).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// _rewakeTask — auto-wake cap (TER-650/G2)
// ─────────────────────────────────────────────────────────────────────────────

const BOARD_WITH_BLOCKED = {
  boardId: 'board_1',
  columns: [
    { columnId: 'c_prog', slug: 'in_progress' },
    { columnId: 'c_blocked', slug: 'blocked' },
  ],
}

function makeG2Service(cap: number) {
  const taskUpdates: any[] = []
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'boards' ? BOARD_WITH_BLOCKED : null),
      updateOne: async (f: any, u: any) => {
        if (name === 'tasks') taskUpdates.push({ filter: f, update: u })
      },
    }),
  } as any
  const svc = new AutoplayService(db, {} as any, {} as any, cap)
  const wakeCalls: any[] = []
  svc.setWakeUpCallback(async (channelId, agentId, text, triggerKind) => {
    wakeCalls.push({ channelId, triggerKind })
  })
  const events: any[] = []
  svc.setEventHandler({ handleScheduledEvent: async (e: any) => { events.push(e); return {} } })
  return { svc, taskUpdates, wakeCalls, events }
}

describe('_rewakeTask — auto-wake cap (TER-650/G2)', () => {
  it('bajo el cap: re-despierta e incrementa el contador', async () => {
    const { svc, taskUpdates, wakeCalls } = makeG2Service(5)
    await (svc as any)._rewakeTask(
      { taskId: 't1', title: 'T', channelId: 'ch_1', autoWakeCount: 2 },
      'agent_1',
      'board_1',
    )
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0].triggerKind).toBe('autorun')
    // $inc del contador antes de despachar.
    expect(taskUpdates.some((u) => u.update.$inc?.autoWakeCount === 1)).toBe(true)
  })

  it('en el cap: NO re-despierta, mueve a blocked y emite el evento', async () => {
    const { svc, taskUpdates, wakeCalls, events } = makeG2Service(5)
    await (svc as any)._rewakeTask(
      { taskId: 't1', title: 'T', channelId: 'ch_1', originChannelId: 'ch_origin', autoWakeCount: 5 },
      'agent_1',
      'board_1',
    )
    // No churn: no wake.
    expect(wakeCalls).toEqual([])
    // Movida a la columna blocked + running:false.
    const blockMove = taskUpdates.find((u) => u.update.$set?.columnId === 'c_blocked')
    expect(blockMove).toBeDefined()
    expect(blockMove.update.$set.running).toBe(false)
    // Notificación al canal supervisor.
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('task.auto_wakes_exhausted')
    expect(events[0].channelId).toBe('ch_origin')
  })

  it('contador undefined (task legacy) cuenta como 0 → re-despierta', async () => {
    const { svc, wakeCalls } = makeG2Service(5)
    await (svc as any)._rewakeTask({ taskId: 't1', title: 'T', channelId: 'ch_1' }, 'agent_1', 'board_1')
    expect(wakeCalls).toHaveLength(1)
  })
})
