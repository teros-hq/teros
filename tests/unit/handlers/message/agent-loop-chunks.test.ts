/**
 * Unit — handleStreamEvent message_chunk payloads (TER-446)
 *
 * Each stream event the LLM emits is fanned out to the channel as a
 * `message_chunk` (or queue_state / agent_phase). That payload IS the streaming
 * contract the frontend renders token-by-token, so it's asserted field-exact
 * (timestamp aside). Real streaming helpers + a captured broadcast mock exercise
 * the actual event→chunk mapping rather than a re-implementation.
 */

import { describe, expect, it, mock } from 'bun:test';
import {
  createStreamingHelpers,
  createStreamingState,
} from '../../../../packages/backend/src/handlers/message/streaming-state';
import { handleStreamEvent } from '../../../../packages/backend/src/handlers/message/agent-loop';

const CH = 'ch_1';

function setup() {
  const broadcast = mock((_c: string, _m: any) => undefined);
  const channelManager = {
    saveMessage: mock(async () => undefined),
    updateMessageContent: mock(async () => undefined),
    createMessageId: (() => {
      let n = 0;
      return () => `msg_${++n}`;
    })(),
    getChannel: async () => ({ channelId: CH }),
    touchMessageTimestamp: mock(async () => undefined),
  } as any;
  const state = createStreamingState();
  const helpers = createStreamingHelpers(state, { channelManager, channelId: CH, agentId: 'a_1', broadcastToChannel: broadcast });
  const ctx = { broadcastToChannel: broadcast, channelManager, maybeAutonameChannel: mock(async () => undefined) } as any;
  // resolveProxyExecution returns null for anything that is not a proxied
  // execute-tool call → these tests exercise the direct (non-tunneled) path.
  const toolExecutor = { getMcaIdForTool: () => 'mca.test', resolveProxyExecution: () => null } as any;
  return { broadcast, state, helpers, ctx, toolExecutor };
}

/** Find the broadcast call whose payload has the given chunkType (or top-level type). */
function findChunk(broadcast: any, kind: string) {
  const call = broadcast.mock.calls.find((c: any[]) => c[1]?.chunkType === kind || c[1]?.type === kind);
  return call?.[1];
}

/**
 * Byte-exact assertion of a chunk: timestamp is non-deterministic (Date.now()),
 * so it's split off and only typechecked; the REST must equal `expected` fully —
 * `toEqual` fails on any extra or changed defined field, so the contract is pinned.
 */
function assertChunkExact(chunk: any, expected: Record<string, unknown>) {
  expect(typeof chunk.timestamp).toBe('number');
  const { timestamp, ...rest } = chunk;
  expect(rest).toEqual(expected);
}

const ev = (message: any) => ({ message });

describe('handleStreamEvent — message_chunk payloads', () => {
  it('text_chunk: emits a text_chunk with the live text message id', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'text_chunk', text: 'Hello' }) as any, CH, state, helpers, toolExecutor);
    const chunk = findChunk(broadcast, 'text_chunk');
    assertChunkExact(chunk, {
      type: 'message_chunk',
      channelId: CH,
      messageId: state.currentTextMessageId,
      chunkType: 'text_chunk',
      text: 'Hello',
    });
  });

  it('tool_start: emits a tool_call_start with resolved mcaId and input', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(
      ctx,
      ev({ type: 'tool_start', toolId: 'tc_1', toolName: 'search', input: { q: 'x' } }) as any,
      CH, state, helpers, toolExecutor,
    );
    const chunk = findChunk(broadcast, 'tool_call_start');
    // The chunk's messageId is the tool message id the helper just created.
    const toolMsgId = helpers.getToolCall('tc_1')?.messageId;
    assertChunkExact(chunk, {
      type: 'message_chunk',
      channelId: CH,
      messageId: toolMsgId,
      chunkType: 'tool_call_start',
      toolCallId: 'tc_1',
      toolName: 'search',
      mcaId: 'mca.test',
      toolInput: { q: 'x' },
    });
  });

  it('tool_complete: emits a tool_call_complete carrying status/output/duration', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'tool_start', toolId: 'tc_1', toolName: 'search', input: {} }) as any, CH, state, helpers, toolExecutor);
    // Capture the tool message id while still tracked (completeToolMessage deletes it).
    const toolMsgId = helpers.getToolCall('tc_1')?.messageId;
    await handleStreamEvent(
      ctx,
      ev({ type: 'tool_complete', toolId: 'tc_1', status: 'completed', output: 'done', duration: 42 }) as any,
      CH, state, helpers, toolExecutor,
    );
    const chunk = findChunk(broadcast, 'tool_call_complete');
    assertChunkExact(chunk, {
      type: 'message_chunk',
      channelId: CH,
      messageId: toolMsgId,
      chunkType: 'tool_call_complete',
      toolCallId: 'tc_1',
      toolStatus: 'completed',
      toolOutput: 'done',
      toolError: undefined,
      toolDuration: 42,
    });
  });

  it('tool_complete: includes attachments only when present', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(
      ctx,
      ev({ type: 'tool_complete', toolId: 'tc_x', status: 'completed', attachments: [{ url: 'u', mime: 'image/png' }] }) as any,
      CH, state, helpers, toolExecutor,
    );
    const chunk = findChunk(broadcast, 'tool_call_complete');
    expect(chunk.attachments).toEqual([{ url: 'u', mime: 'image/png' }]);
  });

  it('queue_state: forwards state + assistantId only when done', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(
      ctx,
      ev({ type: 'queue_state', state: 'done', messageId: 'm1', assistantId: 'as_1', timestamp: 9 }) as any,
      CH, state, helpers, toolExecutor,
    );
    const chunk = findChunk(broadcast, 'queue_state');
    expect(chunk).toEqual({ type: 'queue_state', channelId: CH, messageId: 'm1', state: 'done', assistantId: 'as_1', timestamp: 9 });
  });

  it('agent_phase: forwards the phase verbatim', async () => {
    const { broadcast, state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'agent_phase', phase: 'thinking', timestamp: 7 }) as any, CH, state, helpers, toolExecutor);
    const chunk = findChunk(broadcast, 'agent_phase');
    expect(chunk).toEqual({ type: 'agent_phase', channelId: CH, phase: 'thinking', timestamp: 7 });
  });
});

// These branches of handleStreamEvent have no chunk payload but real side effects;
// found as surviving mutants in the gap audit and pinned here.
describe('handleStreamEvent — side-effect branches', () => {
  it('text_complete: triggers channel auto-naming', async () => {
    const { state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'text_complete' }) as any, CH, state, helpers, toolExecutor);
    expect(ctx.maybeAutonameChannel).toHaveBeenCalledWith(CH);
  });

  it('tool_start: flushes a pending text message before opening the tool', async () => {
    const { state, helpers, ctx, toolExecutor } = setup();
    // Pending assistant text in the buffer when a tool starts.
    helpers.startTextMessage();
    helpers.appendText('partial answer');
    await handleStreamEvent(ctx, ev({ type: 'tool_start', toolId: 'tc_1', toolName: 'search', input: {} }) as any, CH, state, helpers, toolExecutor);
    await new Promise((r) => setTimeout(r, 10)); // completeTextMessage is fire-and-forget
    // The pending text was persisted (a text message saved) before the tool message.
    const textSave = ctx.channelManager.saveMessage.mock.calls.find((c: any[]) => c[0]?.content?.type === 'text');
    expect(textSave).toBeDefined();
    expect(state.currentTextContent).toBe('');
  });

  it('queue_state running: bumps the message timestamp so reload sorts by processing time', async () => {
    const { state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'queue_state', state: 'running', messageId: 'm9', timestamp: 1 }) as any, CH, state, helpers, toolExecutor);
    expect(ctx.channelManager.touchMessageTimestamp).toHaveBeenCalledWith('m9');
  });

  it('queue_state non-running: does NOT bump the timestamp', async () => {
    const { state, helpers, ctx, toolExecutor } = setup();
    await handleStreamEvent(ctx, ev({ type: 'queue_state', state: 'queued', messageId: 'm9', timestamp: 1 }) as any, CH, state, helpers, toolExecutor);
    expect(ctx.channelManager.touchMessageTimestamp).not.toHaveBeenCalled();
  });
});
