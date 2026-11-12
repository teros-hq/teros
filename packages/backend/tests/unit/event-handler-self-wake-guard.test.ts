/**
 * Self-wake guard — un agente NO debe ser despertado por un evento que el mismo
 * causo (decision Pablo 2026-09-24).
 *
 * Escenario real que mata: un runner hace `move-my-task` → board.task_moved →
 * el runner suscrito a su propio board se despierta a si mismo → reacciona →
 * mueve algo → evento → … loop de self-feedback.
 *
 * Contrato verificado aqui: cuando `metadata.actorAgentId === channel.agentId`
 * SOLO se suprime el wake. El evento se inyecta y persiste SIEMPRE (insert en
 * channel_messages + broadcast al canal) — el canal ve el evento, el agente no
 * se auto-despierta. Con actor distinto o sin actor, el wake ocurre normal.
 */

import { describe, expect, it } from 'bun:test';
import { EventHandler } from '../../src/handlers/event-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeHandler(channelAgentId = 'agent_runner') {
  const inserted: any[] = [];
  const broadcasts: any[] = [];
  const wakes: Array<{ channelId: string; agentId: string; prompt: string }> = [];

  const db = {
    collection: () => ({
      insertOne: async (doc: any) => {
        inserted.push(doc);
        return { insertedId: 'x' };
      },
    }),
  } as any;

  const channelManager = {
    getChannel: async (channelId: string) =>
      channelId === 'ch_missing' ? null : { channelId, agentId: channelAgentId },
  } as any;

  const handler = new EventHandler(db, {} as any, channelManager);
  handler.setPubSubService({
    broadcastToTopic: (_topic: string, msg: any) => {
      broadcasts.push(msg);
    },
  } as any);
  handler.setAgentWakeUpCallback(async (channelId, agentId, prompt) => {
    wakes.push({ channelId, agentId, prompt });
  });

  return { handler, inserted, broadcasts, wakes };
}

const boardEvent = (over: Record<string, unknown> = {}) => ({
  channelId: 'ch_sub',
  message: '📋 Board event: task_moved',
  eventType: 'task_update' as const,
  wakeUpAgent: true,
  metadata: {
    source: 'board_subscription',
    boardEventType: 'board.task_moved',
    boardId: 'board_1',
    taskId: 't1',
    taskTitle: 'Mi tarea',
    ...over,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard activo: actor === agente del canal
// ─────────────────────────────────────────────────────────────────────────────

describe('self-wake guard', () => {
  it('runner que mueve SU tarea no se auto-despierta, pero el evento SI aparece en su canal', async () => {
    const { handler, inserted, broadcasts, wakes } = makeHandler('agent_runner');

    const res = await handler.handleScheduledEvent(
      boardEvent({ actorAgentId: 'agent_runner' }) as any,
    );

    expect(res).toEqual({ success: true });
    expect(wakes).toEqual([]); // 🔕 guard: sin wake
    expect(inserted).toHaveLength(1); // …pero persistido
    expect(inserted[0].channelId).toBe('ch_sub');
    expect(inserted[0].content.eventData.actorAgentId).toBe('agent_runner');
    // El canal ve el evento por las dos vias (message + legacy event)
    expect(broadcasts.map((b) => b.type)).toEqual(['message', 'event']);
  });

  it('actor distinto del agente del canal → wake normal + evento inyectado', async () => {
    const { handler, inserted, wakes } = makeHandler('agent_observer');

    const res = await handler.handleScheduledEvent(
      boardEvent({ actorAgentId: 'agent_runner' }) as any,
    );

    expect(res).toEqual({ success: true });
    expect(wakes).toEqual([
      {
        channelId: 'ch_sub',
        agentId: 'agent_observer',
        prompt: expect.stringContaining('[SYSTEM EVENT - TASK UPDATE]'),
      },
    ]);
    expect(inserted).toHaveLength(1);
  });

  it('sin actor en el metadata → wake normal (p.ej. evento del sistema/autoplay)', async () => {
    const { handler, wakes } = makeHandler('agent_runner');

    const res = await handler.handleScheduledEvent(boardEvent() as any);

    expect(res).toEqual({ success: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0].agentId).toBe('agent_runner');
  });

  it('actorUserId (manager humano) NO activa el guard → wake normal', async () => {
    const { handler, wakes } = makeHandler('agent_runner');

    await handler.handleScheduledEvent(boardEvent({ actorUserId: 'user_42' }) as any);

    expect(wakes).toHaveLength(1);
  });

  it('wakeUpAgent=false sigue sin despertar y sin log de guard', async () => {
    const { handler, inserted, wakes } = makeHandler('agent_runner');

    await handler.handleScheduledEvent(
      { ...boardEvent({ actorAgentId: 'otro' }), wakeUpAgent: false } as any,
    );

    expect(wakes).toEqual([]);
    expect(inserted).toHaveLength(1);
  });

  it('canal inexistente → no wake, no insercion (sin cambios)', async () => {
    const { handler, inserted, wakes } = makeHandler('agent_runner');

    const res = await handler.handleScheduledEvent(
      { ...boardEvent({ actorAgentId: 'agent_runner' }), channelId: 'ch_missing' } as any,
    );

    expect(res.success).toBe(false);
    expect(wakes).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
