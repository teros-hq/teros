/**
 * StreamPublisher — gaps TER-469.
 *
 * Complementa StreamPublisher.test.ts (textChunk/queueState/agentPhase/
 * cleanupSession) con los paths sin red: publishTextComplete,
 * publishToolStart/Progress/Complete, publishThinkingChunk,
 * publishMessageComplete (payload exacto a callbacks), flushCallbacks,
 * clearCallbacks, enabled=false en todos los paths y aislamiento de
 * callbacks que lanzan.
 */

import { describe, expect, it } from 'bun:test';
import { StreamPublisher } from './StreamPublisher';
import type { StreamEvent } from './types';

const SESSION = 'sess_1';
const CHANNEL = 'ch_1';
const USER = 'user_1';
const THREAD = 3;

function capture(p: StreamPublisher): StreamEvent[] {
  const events: StreamEvent[] = [];
  p.onStream((e) => {
    events.push(e);
  });
  return events;
}

const ofType = (events: StreamEvent[], type: string) =>
  events.filter((e) => e.message.type === type);

describe('publishTextComplete', () => {
  it('emits text_complete with exact payload and flushes the pending buffer first', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 999 });
    const events = capture(p);

    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'buffered');
    p.publishTextComplete(SESSION, CHANNEL, USER, THREAD, 'full text', 'part_9');

    // El buffer pendiente sale como text_chunk ANTES del text_complete.
    const types = events.map((e) => e.message.type);
    expect(types.indexOf('text_chunk')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('text_chunk')).toBeLessThan(types.indexOf('text_complete'));

    const complete = ofType(events, 'text_complete')[0];
    expect(complete).toEqual({
      channelId: CHANNEL,
      threadId: THREAD,
      userId: USER,
      message: {
        type: 'text_complete',
        sessionId: SESSION,
        timestamp: expect.any(Number),
        text: 'full text',
        partId: 'part_9',
      },
    });
  });
});

describe('text buffer mechanics', () => {
  it('flushTextBuffer after a flush is a no-op (empty buffer must not emit)', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 1 });
    const events = capture(p);

    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'Hello'); // flush inmediato
    const after = ofType(events, 'text_chunk').length;
    p.flushTextBuffer(SESSION, CHANNEL, USER, THREAD); // buffer existe pero text=''

    expect(ofType(events, 'text_chunk').length).toBe(after); // sin chunk vacío espurio
  });

  it('each flush emits only the text accumulated since the previous flush', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 1 });
    const events = capture(p);

    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'A');
    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'B');

    const texts = ofType(events, 'text_chunk').map((e) => (e.message as any).text);
    expect(texts).toEqual(['A', 'B']); // con buffer sin limpiar sería ['A', 'AB']
  });

  it('a chunk of EXACTLY maxChunkSize flushes immediately (>= boundary)', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 60_000, maxChunkSize: 5 });
    const events = capture(p);

    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, '12345'); // len === maxChunkSize

    const texts = ofType(events, 'text_chunk').map((e) => (e.message as any).text);
    expect(texts).toEqual(['12345']);
    p.cleanupSession(SESSION); // no dejar timers colgando
  });
});

describe('publishToolStart', () => {
  it('emits tool_start with derived kind + locations and exact payload', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);

    p.publishToolStart(
      SESSION,
      CHANNEL,
      USER,
      THREAD,
      'tool_1',
      'read',
      { filePath: '/x.ts' },
      'mca.teros.fs',
    );

    const start = ofType(events, 'tool_start')[0];
    expect(start).toEqual({
      channelId: CHANNEL,
      threadId: THREAD,
      userId: USER,
      message: {
        type: 'tool_start',
        sessionId: SESSION,
        timestamp: expect.any(Number),
        toolId: 'tool_1',
        toolName: 'read',
        kind: 'read',
        locations: [{ path: '/x.ts' }],
        input: { filePath: '/x.ts' },
        mcaId: 'mca.teros.fs',
      },
    });
  });

  it('publishes the executing_tool phase before the tool_start event', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishToolStart(SESSION, CHANNEL, USER, THREAD, 't1', 'bash');

    const types = events.map((e) => e.message.type);
    expect(types).toEqual(['agent_phase', 'tool_start']);
    expect((events[0].message as any).phase).toBe('executing_tool');
  });

  it('without input, locations is [] and input undefined', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishToolStart(SESSION, CHANNEL, USER, THREAD, 't1', 'read');

    const msg = ofType(events, 'tool_start')[0].message as any;
    expect(msg.locations).toEqual([]);
    expect(msg.input).toBeUndefined();
  });

  it('flushes pending text before the tool event', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 999 });
    const events = capture(p);
    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'pending');
    p.publishToolStart(SESSION, CHANNEL, USER, THREAD, 't1', 'read');

    const types = events.map((e) => e.message.type);
    expect(types.indexOf('text_chunk')).toBeLessThan(types.indexOf('tool_start'));
  });
});

describe('publishToolProgress', () => {
  it('emits tool_progress with exact payload', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 'tool_1', 'running', [{ path: '/y' }]);

    expect(events).toEqual([
      {
        channelId: CHANNEL,
        threadId: THREAD,
        userId: USER,
        message: {
          type: 'tool_progress',
          sessionId: SESSION,
          timestamp: expect.any(Number),
          toolId: 'tool_1',
          status: 'running',
          locations: [{ path: '/y' }],
        },
      },
    ]);
  });
});

describe('publishToolComplete', () => {
  it('emits tool_complete with exact payload and returns phase to thinking', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishToolComplete(
      SESSION,
      CHANNEL,
      USER,
      THREAD,
      'tool_1',
      'failed',
      undefined,
      'boom',
      125,
      [{ url: 'https://x/y.png', mime: 'image/png', filename: 'y.png' }],
    );

    const types = events.map((e) => e.message.type);
    expect(types).toEqual(['agent_phase', 'tool_complete']);
    expect((events[0].message as any).phase).toBe('thinking');

    expect(events[1].message).toEqual({
      type: 'tool_complete',
      sessionId: SESSION,
      timestamp: expect.any(Number),
      toolId: 'tool_1',
      status: 'failed',
      output: undefined,
      error: 'boom',
      duration: 125,
      attachments: [{ url: 'https://x/y.png', mime: 'image/png', filename: 'y.png' }],
    });
  });
});

describe('publishThinkingChunk', () => {
  it('emits thinking_chunk and flushes pending text first', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 999 });
    const events = capture(p);
    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'pending');
    p.publishThinkingChunk(SESSION, CHANNEL, USER, THREAD, 'hmm...');

    const types = events.map((e) => e.message.type);
    expect(types.indexOf('text_chunk')).toBeLessThan(types.indexOf('thinking_chunk'));
    expect(ofType(events, 'thinking_chunk')[0].message).toEqual({
      type: 'thinking_chunk',
      sessionId: SESSION,
      timestamp: expect.any(Number),
      text: 'hmm...',
    });
  });

  it('empty text → no event', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishThinkingChunk(SESSION, CHANNEL, USER, THREAD, '');
    expect(events).toEqual([]);
  });
});

describe('publishMessageComplete', () => {
  it('emits message_complete and delivers the EXACT messageData to callbacks', () => {
    const p = new StreamPublisher('agent_default');
    const events = capture(p);
    const received: any[] = [];
    p.onMessageComplete((data) => received.push(data));

    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 };
    const breakdown = {
      system: 1,
      tools: 2,
      examples: 0,
      memory: 0,
      summary: 0,
      conversation: 3,
    };
    const toolCalls = [
      { toolCallId: 'c1', toolName: 'read', status: 'completed' as const, output: 'ok' },
    ];

    p.publishMessageComplete(
      SESSION,
      CHANNEL,
      USER,
      THREAD,
      'msg_42',
      999,
      'final text',
      'agent_override',
      toolCalls,
      usage,
      breakdown,
      { id: 'resp_1', model: 'claude-x' },
      'usage_77',
    );

    const complete = ofType(events, 'message_complete')[0];
    expect(complete.message).toEqual({
      type: 'message_complete',
      sessionId: SESSION,
      timestamp: expect.any(Number),
      messageId: 'msg_42',
      totalTokens: 999,
    });

    expect(received).toEqual([
      {
        channelId: CHANNEL,
        messageId: 'msg_42',
        agentId: 'agent_override',
        text: 'final text',
        timestamp: expect.any(Number),
        toolCalls,
        usage,
        breakdown,
        responseMetadata: { id: 'resp_1', model: 'claude-x' },
        sessionUsageId: 'usage_77',
      },
    ]);
  });

  it('agentId falls back to the constructor agent; text falls back to empty string', () => {
    const p = new StreamPublisher('agent_ctor');
    const received: any[] = [];
    p.onMessageComplete((d) => received.push(d));

    p.publishMessageComplete(SESSION, CHANNEL, USER, THREAD, 'msg_1');

    expect(received[0].agentId).toBe('agent_ctor');
    expect(received[0].text).toBe('');
  });

  it('publishes idle phase and cleans the session (phase map + buffer)', () => {
    const p = new StreamPublisher('agent_1', { throttleMs: 1_000, maxChunkSize: 999 });
    p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
    expect(p.getAgentPhase(CHANNEL)).toBe('thinking');

    p.publishMessageComplete(CHANNEL, CHANNEL, USER, THREAD, 'msg_1');
    // Phase pasó a idle y después cleanupSession la borró del Map.
    expect(p.getAgentPhase(CHANNEL)).toBeUndefined();
  });

  it('emits the idle agent_phase BEFORE message_complete (typing indicator clear)', () => {
    const p = new StreamPublisher('agent_1');
    p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
    const events = capture(p);

    p.publishMessageComplete(SESSION, CHANNEL, USER, THREAD, 'msg_1');

    const types = events.map((e) => e.message.type);
    expect(types).toEqual(['agent_phase', 'message_complete']);
    expect((events[0].message as any).phase).toBe('idle');
  });

  it('a throwing messageComplete callback does not break the others', () => {
    const p = new StreamPublisher('agent_1');
    const received: string[] = [];
    p.onMessageComplete(() => {
      throw new Error('cb-1 boom');
    });
    p.onMessageComplete(() => {
      received.push('cb-2');
    });

    p.publishMessageComplete(SESSION, CHANNEL, USER, THREAD, 'msg_1');
    expect(received).toEqual(['cb-2']);
  });
});

describe('callback infrastructure', () => {
  it('a throwing stream callback does not break later callbacks', () => {
    const p = new StreamPublisher('agent_1');
    const seen: string[] = [];
    p.onStream(() => {
      throw new Error('sync boom');
    });
    p.onStream((e) => {
      seen.push(e.message.type);
    });

    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 't1', 'running');
    expect(seen).toEqual(['tool_progress']);
  });

  it('flushCallbacks awaits in-flight async callbacks and drains the pending list', async () => {
    const p = new StreamPublisher('agent_1');
    let resolved = false;
    p.onStream(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 30),
        ),
    );

    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 't1', 'running');
    expect(resolved).toBe(false);
    await p.flushCallbacks();
    expect(resolved).toBe(true);

    // Segunda llamada: lista ya drenada → no-op inmediato.
    await p.flushCallbacks();
  });

  it('a rejecting async callback is contained (logged, not thrown)', async () => {
    const p = new StreamPublisher('agent_1');
    p.onStream(() => Promise.reject(new Error('async boom')));
    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 't1', 'running');
    // No debe lanzar:
    await p.flushCallbacks();
  });

  it('clearCallbacks removes both stream and messageComplete callbacks', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    const completes: any[] = [];
    p.onMessageComplete((d) => completes.push(d));

    p.clearCallbacks();
    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 't1', 'running');
    p.publishMessageComplete(SESSION, CHANNEL, USER, THREAD, 'msg_1');

    expect(events).toEqual([]);
    expect(completes).toEqual([]);
  });
});

describe('enabled=false silences every path', () => {
  it('no events and no messageComplete callbacks on any publish method', () => {
    const p = new StreamPublisher('agent_1', { enabled: false });
    const events = capture(p);
    const completes: any[] = [];
    p.onMessageComplete((d) => completes.push(d));

    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'x');
    p.publishTextComplete(SESSION, CHANNEL, USER, THREAD, 'x', 'part_1');
    p.publishToolStart(SESSION, CHANNEL, USER, THREAD, 't1', 'read');
    p.publishToolProgress(SESSION, CHANNEL, USER, THREAD, 't1', 'running');
    p.publishToolComplete(SESSION, CHANNEL, USER, THREAD, 't1', 'completed');
    p.publishThinkingChunk(SESSION, CHANNEL, USER, THREAD, 'mm');
    p.publishMessageComplete(SESSION, CHANNEL, USER, THREAD, 'msg_1');
    p.publishQueueStateChange(CHANNEL, USER, 'msg_1', 'pending', THREAD);
    p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);

    expect(events).toEqual([]);
    expect(completes).toEqual([]);
    expect(p.getAgentPhase(CHANNEL)).toBeUndefined();
  });

  it('empty text chunk emits nothing even when enabled', () => {
    const p = new StreamPublisher('agent_1');
    const events = capture(p);
    p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, '');
    expect(events).toEqual([]);
  });
});
