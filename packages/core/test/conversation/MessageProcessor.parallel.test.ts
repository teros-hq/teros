/**
 * Concurrency safety of `MessageProcessor.handleToolResult` — the linchpin
 * of the parallel tool dispatch added to `TurnDriver.dispatchToolCalls`.
 *
 * What we're proving:
 *   1. N concurrent `handleToolResult(callId)` calls all complete; the
 *      `toolCalls` Map ends empty (every entry deleted by its own call).
 *   2. Each `writePart` writes the correct part state (no cross-talk
 *      between concurrent calls — calls keyed by `toolCallId` mutate
 *      disjoint entries).
 *   3. A failing tool result does NOT block other concurrent results.
 *   4. `handleToolResult` for an unknown id is silent (race-free under
 *      double-dispatch / late completion).
 */
import { describe, expect, it } from 'bun:test';
import { MessageProcessor } from '../../src/conversation/MessageProcessor';
import type { SessionStore } from '../../src/session/SessionStore';
import type { ToolCall } from '../../src/llm/ILLMClient';
import type { Part, ToolPart } from '../../src/session/types';

// Suppress noisy console.warn from MessageProcessor for the "unknown id"
// and "double-dispatch" tests — they intentionally trigger that path.

/**
 * Snapshot of a toolPart at the moment of writing — the processor reassigns
 * `toolPart.state` after `handleToolResult`, so storing the raw reference
 * would let later mutations mutate our "history". Cloning the relevant
 * fields freezes the value at write time.
 */
type WrittenPart = {
  callID: string;
  status: 'running' | 'completed' | 'error';
  output?: string;
  error?: string;
};

class FakeSessionStore {
  public partsWritten: WrittenPart[] = [];
  async writePart(part: Part): Promise<void> {
    // Tiny await keeps the parallel branches interleaving in the event loop.
    await new Promise((r) => setTimeout(r, 0));
    if (part.type !== 'tool') return;
    const tp = part as ToolPart;
    const s = tp.state as { status: 'running' | 'completed' | 'error'; output?: string; error?: string };
    this.partsWritten.push({
      callID: tp.callID,
      status: s.status,
      output: s.output,
      error: s.error,
    });
  }
  async writeMessage(): Promise<void> {}
  async updateMessage(): Promise<void> {}
}

function makeToolCall(id: string, name: string): ToolCall {
  return { id, name, input: { fixture: id }, metadata: undefined } as ToolCall;
}

async function bootstrap(): Promise<{
  processor: MessageProcessor;
  store: FakeSessionStore;
}> {
  const store = new FakeSessionStore();
  const processor = new MessageProcessor(
    store as unknown as SessionStore,
    'sess_test',
    new AbortController().signal,
  );
  await processor.next();
  return { processor, store };
}

describe('MessageProcessor.handleToolResult — parallel dispatch safety', () => {
  it('processes N concurrent tool results without dropping any', async () => {
    const { processor, store } = await bootstrap();
    const ids = ['t1', 't2', 't3', 't4', 't5'];
    for (const id of ids) await processor.handleToolCall(makeToolCall(id, `tool_${id}`));

    await Promise.all(
      ids.map((id) =>
        processor.handleToolResult({ toolCallId: id, output: `out_${id}`, isError: false }),
      ),
    );

    // Every entry has been removed by its own handler.
    for (const id of ids) {
      expect((processor as unknown as { toolCalls: Map<string, ToolPart> }).toolCalls.has(id)).toBe(
        false,
      );
    }
    // writePart fired once per tool_call AND once per tool_result → 2N writes.
    // (handleToolCall writes the running part; handleToolResult overwrites with completed.)
    const completedParts = store.partsWritten.filter(
      (p) => p.status === 'completed' || p.status === 'error',
    );
    expect(completedParts).toHaveLength(ids.length);
    const completedIds = completedParts.map((p) => p.callID).sort();
    expect(completedIds).toEqual(ids.slice().sort());
  });

  it('a failing tool result does not block siblings', async () => {
    const { processor } = await bootstrap();
    const ids = ['ok1', 'fail', 'ok2'];
    for (const id of ids) await processor.handleToolCall(makeToolCall(id, `tool_${id}`));

    await Promise.all(
      ids.map((id) =>
        processor.handleToolResult({
          toolCallId: id,
          output: id === 'fail' ? 'boom' : `out_${id}`,
          isError: id === 'fail',
        }),
      ),
    );

    const map = (processor as unknown as { toolCalls: Map<string, ToolPart> }).toolCalls;
    expect(map.has('ok1')).toBe(false);
    expect(map.has('ok2')).toBe(false);
    expect(map.has('fail')).toBe(false);
  });

  it('mutations on distinct toolCallIds do NOT cross-talk', async () => {
    const { processor, store } = await bootstrap();
    await processor.handleToolCall(makeToolCall('a', 'tool_a'));
    await processor.handleToolCall(makeToolCall('b', 'tool_b'));
    // Interleave: result for `a` resolves after result for `b` started.
    await Promise.all([
      processor.handleToolResult({ toolCallId: 'b', output: 'result_b', isError: false }),
      processor.handleToolResult({ toolCallId: 'a', output: 'result_a', isError: false }),
    ]);
    const completedA = store.partsWritten.find(
      (p) => p.callID === 'a' && p.status === 'completed',
    );
    const completedB = store.partsWritten.find(
      (p) => p.callID === 'b' && p.status === 'completed',
    );
    expect(completedA?.output).toBe('result_a');
    expect(completedB?.output).toBe('result_b');
  });

  it('handleToolResult for an unknown id is silent (idempotent under late delivery)', async () => {
    const { processor } = await bootstrap();
    await expect(
      processor.handleToolResult({ toolCallId: 'never_streamed', output: 'x', isError: false }),
    ).resolves.toBeUndefined();
  });

  it('double-dispatch of the same id is a no-op on the second call', async () => {
    const { processor, store } = await bootstrap();
    await processor.handleToolCall(makeToolCall('once', 'tool_once'));
    await processor.handleToolResult({ toolCallId: 'once', output: 'first', isError: false });
    // Second call: entry already deleted by the first.
    await processor.handleToolResult({ toolCallId: 'once', output: 'second', isError: false });
    const completed = store.partsWritten.filter(
      (p) => p.callID === 'once' && p.status === 'completed',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].output).toBe('first');
  });
});
