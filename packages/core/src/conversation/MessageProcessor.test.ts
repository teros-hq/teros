/**
 * MessageProcessor tests (TER-445).
 *
 * Contract: assistant message lifecycle + event ordering against a REAL
 * StreamPublisher (factory real — TESTING-QUALITY §4) and a snapshot-faithful
 * SessionStore fake (writePart upsert semantics, deep-copied at call time
 * because the processor mutates the same part object between writes).
 *
 * Key invariants under test:
 *  - publishToolStart → flushCallbacks SETTLED → writePart (Gemini race, TER-42)
 *  - a publisher failure must NOT prevent writePart/executeTool (GAP-16 defense)
 *  - seedId honored only on the very first next()
 */

import { describe, expect, it } from 'bun:test';
import type { ToolCall } from '../llm/ILLMClient';
import type { SessionStore } from '../session/SessionStore';
import type { Part, TextPart, ToolPart } from '../session/types';
import { StreamPublisher } from '../streaming';
import type { StreamEvent } from '../streaming/types';
import { MessageProcessor } from './MessageProcessor';

const SESSION = 'session_test';
const CTX = { channelId: 'ch_test', userId: 'user_test', threadId: undefined };

describe('MessageProcessor.next', () => {
  it('honors seedId on the first call and persists the assistant skeleton', async () => {
    const { store, processor } = setup();
    const before = Date.now();
    const msg = await processor.next('message_seed_1');

    expect(msg.id).toBe('message_seed_1');
    expect(store.writeMessageCalls.length).toBe(1);
    const written = store.writeMessageCalls[0] as Record<string, unknown>;
    expect(written.id).toBe('message_seed_1');
    expect(written.sessionID).toBe(SESSION);
    expect(written.role).toBe('assistant');
    expect(written.modelID).toBe('');
    expect(written.providerID).toBe('');
    expect(written.mode).toBe('build');
    expect(written.cost).toBe(0);
    expect(written.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect((written.time as { created: number }).created).toBeGreaterThanOrEqual(before);
  });

  it('ignores seedId on the second call (generates a fresh id)', async () => {
    const { processor } = setup();
    await processor.next('message_seed_1');
    const second = await processor.next('message_seed_2');
    expect(second.id).not.toBe('message_seed_2');
    expect(second.id).not.toBe('message_seed_1');
  });

  it('a first call WITHOUT seed consumes the seed budget — later seeds are ignored', async () => {
    const { processor } = setup();
    const first = await processor.next();
    const second = await processor.next('message_seed_late');
    expect(first.id).not.toBe('message_seed_late');
    expect(second.id).not.toBe('message_seed_late');
  });
});

describe('MessageProcessor.handleTextChunk / finishTextPart', () => {
  it('throws if called before next()', async () => {
    const { processor } = setup();
    await expect(processor.handleTextChunk('hola')).rejects.toThrow(
      'No current message - call next() first',
    );
  });

  it('accumulates chunks onto the SAME part id, persisting growing text each chunk', async () => {
    const { store, processor } = setup();
    await processor.next('message_a');
    await processor.handleTextChunk('Hola');
    await processor.handleTextChunk(' mundo');

    const writes = store.writePartCalls as TextPart[];
    expect(writes.length).toBe(2);
    expect(writes[0]!.text).toBe('Hola');
    expect(writes[1]!.text).toBe('Hola mundo');
    expect(writes[0]!.id).toBe(writes[1]!.id);
    expect(writes[0]!.messageID).toBe('message_a');
    expect(writes[0]!.type).toBe('text');
  });

  it('publishes live text_chunk events with the exact streamed text (survivor M7)', async () => {
    const { processor, events } = setup();
    await processor.next('message_a');
    await processor.handleTextChunk('Hola');
    await processor.handleTextChunk(' mundo');

    const chunks = events.filter((e) => e.message.type === 'text_chunk');
    expect(chunks.map((c) => (c.message as { text: string }).text)).toEqual(['Hola', ' mundo']);
    expect({ ...chunks[0]!, message: { ...chunks[0]!.message, timestamp: 0 } }).toEqual({
      channelId: 'ch_test',
      threadId: undefined,
      userId: 'user_test',
      message: { type: 'text_chunk', sessionId: SESSION, timestamp: 0, text: 'Hola' },
    });
  });

  it('finishTextPart trims trailing whitespace, stamps time.end, publishes text_complete, and resets', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.handleTextChunk('Hola  ');
    await processor.finishTextPart();

    const finalWrite = store.writePartCalls.at(-1) as TextPart;
    expect(finalWrite.text).toBe('Hola');
    expect(finalWrite.time?.end).toBeGreaterThan(0);

    const complete = events.find((e) => e.message.type === 'text_complete');
    expect(complete).toBeDefined();
    expect({ ...complete!.message, timestamp: 0 }).toEqual({
      type: 'text_complete',
      sessionId: SESSION,
      timestamp: 0,
      text: 'Hola',
      partId: finalWrite.id,
    });

    // Reset: the next chunk opens a NEW part.
    await processor.handleTextChunk('otro');
    const nextWrite = store.writePartCalls.at(-1) as TextPart;
    expect(nextWrite.id).not.toBe(finalWrite.id);
    expect(nextWrite.text).toBe('otro');
  });

  it('finishTextPart with no open part is a no-op (no write, no event)', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.finishTextPart();
    expect(store.writePartCalls.length).toBe(0);
    expect(events.filter((e) => e.message.type === 'text_complete').length).toBe(0);
  });
});

describe('MessageProcessor.handleToolCall', () => {
  it('publishes tool_start and AWAITS flushCallbacks before writePart (Gemini race / TER-42)', async () => {
    const { store, processor, publisher } = setup();
    const order: string[] = [];
    publisher.onStream(async (ev) => {
      order.push(`cb-start:${ev.message.type}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`cb-settled:${ev.message.type}`);
    });
    store.onWritePart = (part) => order.push(`writePart:${part.type}`);

    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', { q: 'teros' }));

    expect(order).toEqual([
      'cb-start:agent_phase',
      'cb-start:tool_start',
      'cb-settled:agent_phase',
      'cb-settled:tool_start',
      'writePart:tool',
    ]);
  });

  it('persists the tool part in running state with the exact tool_start payload', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', { q: 'teros' }));

    const written = store.writePartCalls[0] as ToolPart;
    expect(written.type).toBe('tool');
    expect(written.tool).toBe('web_search');
    expect(written.callID).toBe('call_1');
    expect(written.messageID).toBe('message_a');
    expect(written.state.status).toBe('running');
    expect(written.state.input).toEqual({ q: 'teros' });

    const start = events.find((e) => e.message.type === 'tool_start');
    expect({ ...start!.message, timestamp: 0 }).toEqual({
      type: 'tool_start',
      sessionId: SESSION,
      timestamp: 0,
      toolId: 'call_1',
      toolName: 'web_search',
      kind: 'other',
      locations: [],
      input: { q: 'teros' },
      mcaId: undefined,
    });
    expect(processor.getToolCalls().map((t) => t.callID)).toEqual(['call_1']);
  });

  it('closes a pending text part BEFORE the tool (text→tool→text yields two distinct text parts)', async () => {
    const { store, processor } = setup();
    await processor.next('message_a');
    await processor.handleTextChunk('antes ');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));
    await processor.handleTextChunk('despues');
    await processor.finishTextPart();

    const textWrites = (store.writePartCalls as Part[]).filter(
      (p): p is TextPart => p.type === 'text',
    );
    const distinctIds = [...new Set(textWrites.map((p) => p.id))];
    expect(distinctIds.length).toBe(2);
    const finalTexts = distinctIds.map(
      (id) => textWrites.filter((p) => p.id === id).at(-1)!.text,
    );
    expect(finalTexts).toEqual(['antes', 'despues']);
  });

  it('a publisher that THROWS does not prevent writePart nor tool registration (GAP-16)', async () => {
    const store = new FakeSessionStore();
    const throwingPublisher = {
      publishToolStart: () => {
        throw new Error('publisher down');
      },
      flushCallbacks: async () => undefined,
    } as unknown as StreamPublisher;
    const processor = new MessageProcessor(
      store as unknown as SessionStore,
      SESSION,
      new AbortController().signal,
      throwingPublisher,
      CTX,
    );
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));

    expect(store.writePartCalls.length).toBe(1);
    expect((store.writePartCalls[0] as ToolPart).callID).toBe('call_1');
    expect(processor.getToolCalls().length).toBe(1);
  });

  it('an async stream callback that REJECTS is absorbed and writePart still proceeds', async () => {
    const { store, processor, publisher } = setup();
    publisher.onStream(async () => {
      throw new Error('WS disconnected');
    });
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));
    expect(store.writePartCalls.length).toBe(1);
    expect(processor.getToolCalls().length).toBe(1);
  });

  it('throws if called before next()', async () => {
    const { processor } = setup();
    await expect(
      processor.handleToolCall(mkToolCall('call_1', 'web_search', {})),
    ).rejects.toThrow('No current message - call next() first');
  });
});

describe('MessageProcessor.handleToolResult', () => {
  it('success → exact completed state + exact tool_complete payload + map cleanup', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', { q: 'x' }));
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'resultado' });

    const written = store.writePartCalls.at(-1) as ToolPart;
    const state = written.state as {
      status: string;
      input: unknown;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number };
    };
    expect({ ...state, time: { start: 0, end: 0 } }).toEqual({
      status: 'completed',
      input: { q: 'x' },
      output: 'resultado',
      title: '',
      metadata: {},
      time: { start: 0, end: 0 },
    });
    expect(state.time.end).toBeGreaterThanOrEqual(state.time.start);

    const complete = events.find((e) => e.message.type === 'tool_complete');
    expect({ ...complete!.message, timestamp: 0, duration: 0 }).toEqual({
      type: 'tool_complete',
      sessionId: SESSION,
      timestamp: 0,
      toolId: 'call_1',
      status: 'completed',
      output: 'resultado',
      error: undefined,
      duration: 0,
      attachments: undefined,
    });
    const msg = complete!.message as { duration?: number };
    expect(msg.duration).toBe(state.time.end - state.time.start);

    // Map cleanup: the call is no longer pending.
    expect(processor.getToolCalls()).toEqual([]);
  });

  it('isError → exact error state + tool_complete failed carries error (not output)', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', { q: 'x' }));
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'algo falló', isError: true });

    const written = store.writePartCalls.at(-1) as ToolPart;
    const state = written.state as {
      status: string;
      input: unknown;
      error: string;
      time: { start: number; end: number };
    };
    expect({ ...state, time: { start: 0, end: 0 } }).toEqual({
      status: 'error',
      input: { q: 'x' },
      error: 'algo falló',
      time: { start: 0, end: 0 },
    });

    const complete = events.find((e) => e.message.type === 'tool_complete');
    const msg = complete!.message as { status: string; output?: string; error?: string };
    expect(msg.status).toBe('failed');
    expect(msg.output).toBeUndefined();
    expect(msg.error).toBe('algo falló');
  });

  it('attachments: present only when non-empty (empty array does NOT add the field)', async () => {
    const { store, processor } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'ok', attachments: [] });
    const noAttach = store.writePartCalls.at(-1) as ToolPart;
    expect('attachments' in (noAttach.state as object)).toBe(false);

    await processor.handleToolCall(mkToolCall('call_2', 'web_search', {}));
    const file = {
      id: 'part_file',
      sessionID: SESSION,
      messageID: 'message_a',
      type: 'file' as const,
      mime: 'image/png',
      url: 'https://x/img.png',
      filename: 'img.png',
    };
    await processor.handleToolResult({ toolCallId: 'call_2', output: 'ok', attachments: [file] });
    const withAttach = store.writePartCalls.at(-1) as ToolPart;
    expect((withAttach.state as { attachments?: unknown[] }).attachments).toEqual([file]);
  });

  it('duration reflects real elapsed time (end strictly after start)', async () => {
    // Survivor hunt M8: with `end := start` the duration freezes at 0 and the
    // frontend shows bogus tool timings — assert real elapsed time.
    const { store, processor, events } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));
    await new Promise((r) => setTimeout(r, 5));
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'ok' });

    const written = store.writePartCalls.at(-1) as ToolPart;
    const state = written.state as { time: { start: number; end: number } };
    expect(state.time.end).toBeGreaterThan(state.time.start);

    const complete = events.find((e) => e.message.type === 'tool_complete');
    const duration = (complete!.message as { duration?: number }).duration;
    expect(duration).toBe(state.time.end - state.time.start);
    expect(duration!).toBeGreaterThanOrEqual(4);
  });

  it('unknown toolCallId → no write, no event, no throw', async () => {
    const { store, processor, events } = setup();
    await processor.next('message_a');
    const writesBefore = store.writePartCalls.length;
    await processor.handleToolResult({ toolCallId: 'call_ghost', output: 'x' });
    expect(store.writePartCalls.length).toBe(writesBefore);
    expect(events.filter((e) => e.message.type === 'tool_complete').length).toBe(0);
  });

  it('a second result for the same call is ignored (first wins)', async () => {
    const { store, processor } = setup();
    await processor.next('message_a');
    await processor.handleToolCall(mkToolCall('call_1', 'web_search', {}));
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'primero' });
    const writesAfterFirst = store.writePartCalls.length;
    await processor.handleToolResult({ toolCallId: 'call_1', output: 'segundo', isError: true });
    expect(store.writePartCalls.length).toBe(writesAfterFirst);
    const final = store.writePartCalls.at(-1) as ToolPart;
    expect((final.state as { output?: string }).output).toBe('primero');
    expect(final.state.status).toBe('completed');
  });
});

describe('MessageProcessor.finish', () => {
  it('stamps completion + metadata and returns {info, parts, blocked} from the store', async () => {
    const { store, processor } = setup();
    await processor.next('message_a');
    await processor.handleTextChunk('respuesta');
    const result = await processor.finish({
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 7 },
      metadata: { model: 'claude-test-1' },
    });

    expect(result.info.id).toBe('message_a');
    expect(result.info.time.completed).toBeGreaterThan(0);
    expect(result.info.modelID).toBe('claude-test-1');
    expect(result.info.tokens).toEqual({
      input: 11,
      output: 7,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(result.blocked).toBe(false);
    // Parts come from the store (upsert by id): one finished text part.
    expect(result.parts.length).toBe(1);
    expect((result.parts[0] as TextPart).text).toBe('respuesta');
    // The completed message skeleton was re-persisted.
    expect(store.writeMessageCalls.length).toBe(2);
  });

  it('without metadata, modelID/tokens stay at their defaults', async () => {
    const { processor } = setup();
    await processor.next('message_a');
    const result = await processor.finish({ stopReason: 'end_turn' });
    expect(result.info.modelID).toBe('');
    expect(result.info.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  });

  it('setBlocked(true) is reflected in the result', async () => {
    const { processor } = setup();
    await processor.next('message_a');
    processor.setBlocked(true);
    const result = await processor.finish({ stopReason: 'end_turn' });
    expect(result.blocked).toBe(true);
  });

  it('throws if called before next()', async () => {
    const { processor } = setup();
    await expect(processor.finish({ stopReason: 'end_turn' })).rejects.toThrow(
      'No current message - call next() first',
    );
  });
});

// ---------------------------------------------------------------------------
// Fakes — faithful to the real boundaries.
// ---------------------------------------------------------------------------

/**
 * In-memory SessionStore: snapshots every write at call time (the processor
 * mutates the same object between writes) and replicates upsert-by-id so
 * listParts returns the LAST persisted version of each part.
 */
class FakeSessionStore {
  writePartCalls: Part[] = [];
  writeMessageCalls: unknown[] = [];
  onWritePart?: (part: Part) => void;

  async writeMessage(message: unknown): Promise<void> {
    this.writeMessageCalls.push(structuredClone(message));
  }

  async writePart(part: Part): Promise<void> {
    this.onWritePart?.(part);
    this.writePartCalls.push(structuredClone(part));
  }

  async listParts(messageId: string): Promise<Part[]> {
    const byId = new Map<string, Part>();
    for (const p of this.writePartCalls) {
      if (p.messageID === messageId) byId.set(p.id, p);
    }
    return [...byId.values()];
  }
}

function setup() {
  const store = new FakeSessionStore();
  const events: StreamEvent[] = [];
  // Real publisher; maxChunkSize 1 + throttleMs 0 make text batching immediate
  // and deterministic (no timers left behind).
  const publisher = new StreamPublisher('agent_test', {
    enabled: true,
    throttleMs: 0,
    maxChunkSize: 1,
  });
  publisher.onStream((ev) => {
    events.push(structuredClone(ev) as StreamEvent);
  });
  const processor = new MessageProcessor(
    store as unknown as SessionStore,
    SESSION,
    new AbortController().signal,
    publisher,
    CTX,
  );
  return { store, events, publisher, processor };
}

function mkToolCall(id: string, name: string, input: Record<string, unknown>): ToolCall {
  return { id, name, input: input as Record<string, any> };
}
