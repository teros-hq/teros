/**
 * TurnDriver.runTurn tests (TER-445).
 *
 * Contract + lifecycle of the turn orchestrator against faithful boundaries:
 *  - live in-memory SessionStore (upsert semantics, snapshots at write time) so
 *    the INV-1 reconcile chain (assertInvariantINV1 → synthesizeOrphans →
 *    reload) runs REAL, not mocked;
 *  - scripted ILLMClient that drives the real streaming callbacks;
 *  - tool executor with deferred, abort-aware behaviors;
 *  - REAL StreamPublisher + REAL interrupt strategies.
 *
 * Covers: TER-386 per-turn dispatch mode, step_end break on queued messages
 * (in-flight tools always complete), emergency compaction on prompt-too-long,
 * max-steps blocking, memory hooks, and the published turn-complete payload.
 */

import { describe, expect, it } from 'bun:test';
import type { CompactionService } from '../compaction';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from '../llm/ILLMClient';
import type { IMemoryHooks } from '../memory/IMemoryHooks';
import type { SessionStore } from '../session/SessionStore';
import type { MessageWithParts, Part, ToolPart } from '../session/types';
import { StreamPublisher } from '../streaming';
import type { StreamEvent } from '../streaming/types';
import type { ToolExecutionOptions, ToolExecutionResult } from '../tools/IToolExecutor';
import type { PromptInput } from './ConversationManager';
import { boundaryAware } from './InterruptStrategy';
import { TurnAccumulator, TurnDriver, type TurnDriverDeps } from './TurnDriver';
import { OperationTimeoutError } from '../util/operationTimeout';

const SESSION = 'session_t1';
/** Fixed epoch for the default harness clock (2024-07-03) — keeps wrapper-
 * measured latency/ttft deterministic (0) unless a test injects an advancing
 * clock. See TurnDriver's wrapper-timing fallback (TER-615 follow-up). */
const FIXED_NOW = 1_720_000_000_000;

describe('TurnDriver.runTurn — happy path', () => {
  it('runs a 2-step turn (tool → text) and publishes the exact turn-complete payload', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok:search', isError: false }));
    t.llm.scripts = [
      { toolCalls: [tc('call_a', 'search', { q: 'x' })], response: r('tool_calls', 100, 10) },
      { onText: ['fin'], response: r('end_turn', 150, 5) },
    ];

    const driver = new TurnDriver(t.deps);
    const result = await driver.runTurn(mkInput(), { signal: new AbortController().signal });

    // Two LLM calls; the second one carries the COMPLETED tool result.
    expect(t.llm.calls.length).toBe(2);
    const secondCallToolParts = t.llm.calls[1]!.messages
      .flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool');
    expect(secondCallToolParts.length).toBe(1);
    expect(secondCallToolParts[0]!.state.status).toBe('completed');
    expect((secondCallToolParts[0]!.state as { output?: string }).output).toBe('ok:search');

    // Tool executed exactly once with the full execution context.
    expect(t.executor.executions.length).toBe(1);
    const exec = t.executor.executions[0]!;
    expect(exec.name).toBe('search');
    expect(exec.input).toEqual({ q: 'x' });
    expect(exec.options.toolCallId).toBe('call_a');
    expect(exec.options.sessionUsageId).toBe('usage_1');
    // stepIndex is 1 for tools produced by the FIRST llm call: the driver
    // increments `step` before dispatching. tool_executions rows already
    // persist this 1-based meaning (see database.ts `(sessionUsageId,
    // stepIndex+1)`) — the 0-based wording in IToolExecutor's docstring is
    // stale, the VALUE is the contract. Do not "fix" to 0 without a data
    // migration (meaning-change bug class, CLAUDE.md global).
    expect(exec.options.stepIndex).toBe(1);
    expect(exec.options.toolCallIndex).toBe(0);
    expect(exec.options.signal).toBeInstanceOf(AbortSignal);

    // The final assistant message is the LAST step's (not the pinned turn id —
    // each step opens a fresh assistant message; the pin applies to step 0).
    expect(result.parts.some((p) => p.type === 'text' && (p as { text: string }).text === 'fin')).toBe(true);
    expect(result.info.id).not.toBe('message_turn_1');
    const step0 = t.store.partByCallId('call_a');
    expect(step0!.messageID).toBe('message_turn_1');

    // Exact turn-complete callback payload (usage accumulated across steps).
    expect(t.completions.length).toBe(1);
    const data = t.completions[0] as Record<string, unknown>;
    const breakdown = data.breakdown as { output?: number };
    expect({ ...data, timestamp: 0, breakdown: undefined, toolCalls: undefined }).toEqual({
      channelId: 'ch_1',
      messageId: result.info.id,
      agentId: 'agent_test',
      text: 'fin',
      timestamp: 0,
      toolCalls: undefined,
      usage: { inputTokens: 250, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      breakdown: undefined,
      // TER-615: responseMetadata is now the real per-turn telemetry (was
      // hardcoded undefined). The scripted LLM emits no metadata/onFinish, so
      // only finishReason is set, derived from the last step's stopReason.
      responseMetadata: { finishReason: 'end_turn' },
      sessionUsageId: 'usage_1',
    });
    expect(breakdown.output).toBe(10); // breakdown scaled on the FIRST call
    const toolCalls = data.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls.length).toBe(1);
    expect({ ...toolCalls[0], duration: 0 }).toEqual({
      toolCallId: 'call_a',
      toolName: 'search',
      input: { q: 'x' },
      status: 'completed',
      output: 'ok:search',
      error: undefined,
      duration: 0,
    });

    // Agent phase lifecycle, exact sequence. The double trailing 'idle' is
    // real: publishMessageComplete publishes idle then cleanupSession() drops
    // the dedup entry, so the belt-and-braces finally re-publishes it.
    expect(phases(t.events)).toEqual([
      'thinking',
      'executing_tool',
      'thinking',
      'streaming_text',
      'idle',
      'idle',
    ]);
  });

  it('adds cacheReadTokens into the message-complete token scalar (TER-650 merge)', async () => {
    // Adapters normalize `inputTokens` to EXCLUDE cache reads (usage-normalize), so
    // TurnDriver must add cacheReadTokens back into the headline "tokens processed"
    // scalar or the cached path (kimi/Fireworks) undercounts. Regression guard for
    // the merge that took the pre-normalization scalar. Mutation: revert
    // publishMessageComplete to `inputTokens + outputTokens` → 110 !== 140 → red.
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.llm.scripts = [
      {
        onText: ['resp'],
        response: {
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 30 },
        },
      },
    ];
    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    const complete = t.events.find((e) => e.message.type === 'message_complete');
    expect(complete, 'se publicó message_complete').toBeTruthy();
    // 100 (input, cache-excluded) + 30 (cacheRead) + 10 (output) = 140, NOT 110.
    expect((complete?.message as { totalTokens?: number }).totalTokens).toBe(140);
  });

  it('single-step turn pins the assistant id to input.assistantTurnId', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.llm.scripts = [{ onText: ['hola!'], response: r('end_turn', 10, 2) }];
    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });
    expect(result.info.id).toBe('message_turn_1');
  });

  it('loads a pre-existing compaction summary into sessionSummaries', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.store.summaryToReturn = 'S_PREV';
    t.llm.scripts = [{ onText: ['ok'], response: r('end_turn', 10, 2) }];
    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });
    expect(t.deps.sessionSummaries.get(SESSION)).toBe('S_PREV');
  });

  it('rejects with a tool-name-conflict error when two apps expose the same tool', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.tools = [mkTool('appA_run'), mkTool('appA_run')];
    t.llm.scripts = [{ onText: ['x'], response: r('end_turn', 1, 1) }];
    await expect(
      new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal }),
    ).rejects.toThrow('Tool name conflict detected');
  });
});

describe('TurnDriver — TER-386 per-turn dispatch mode', () => {
  it('input.toolExecutionMode=sequential WINS over deps parallel (worker-reuse regression)', async () => {
    const t = mkDeps({ toolExecutionMode: 'parallel' });
    t.store.seedUserMessage('message_u01', 'hola');
    const alpha = deferred<ToolExecutionResult>();
    t.executor.behave('alpha', () => alpha.promise);
    t.executor.behave('beta', async () => ({ output: 'b', isError: false }));
    t.llm.scripts = [
      {
        toolCalls: [tc('call_a', 'alpha', {}), tc('call_b', 'beta', {})],
        response: r('tool_calls', 10, 1),
      },
      { onText: ['fin'], response: r('end_turn', 10, 1) },
    ];

    const run = new TurnDriver(t.deps).runTurn(mkInput({ toolExecutionMode: 'sequential' }), {
      signal: new AbortController().signal,
    });
    await until(() => t.executor.executions.length === 1);
    await sleep(20); // give a wrongly-parallel dispatch the chance to start beta
    expect(t.executor.executions.map((e) => e.name)).toEqual(['alpha']);

    alpha.resolve({ output: 'a', isError: false });
    await run;
    expect(t.executor.executions.map((e) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('input.toolExecutionMode=parallel WINS over deps sequential (both tools in flight)', async () => {
    const t = mkDeps({ toolExecutionMode: 'sequential' });
    t.store.seedUserMessage('message_u01', 'hola');
    const alpha = deferred<ToolExecutionResult>();
    const beta = deferred<ToolExecutionResult>();
    t.executor.behave('alpha', () => alpha.promise);
    t.executor.behave('beta', () => beta.promise);
    t.llm.scripts = [
      {
        toolCalls: [tc('call_a', 'alpha', {}), tc('call_b', 'beta', {})],
        response: r('tool_calls', 10, 1),
      },
      { onText: ['fin'], response: r('end_turn', 10, 1) },
    ];

    const run = new TurnDriver(t.deps).runTurn(mkInput({ toolExecutionMode: 'parallel' }), {
      signal: new AbortController().signal,
    });
    // Both must start WITHOUT either resolving — that's concurrency.
    await until(() => t.executor.executions.length === 2);
    expect(t.executor.executions.map((e) => e.name)).toEqual(['alpha', 'beta']);

    alpha.resolve({ output: 'a', isError: false });
    beta.resolve({ output: 'b', isError: false });
    await run;
  });

  it('falls back to the construction-time dep when the input carries no mode', async () => {
    const t = mkDeps({ toolExecutionMode: 'parallel' });
    t.store.seedUserMessage('message_u01', 'hola');
    const alpha = deferred<ToolExecutionResult>();
    const beta = deferred<ToolExecutionResult>();
    t.executor.behave('alpha', () => alpha.promise);
    t.executor.behave('beta', () => beta.promise);
    t.llm.scripts = [
      {
        toolCalls: [tc('call_a', 'alpha', {}), tc('call_b', 'beta', {})],
        response: r('tool_calls', 10, 1),
      },
      { onText: ['fin'], response: r('end_turn', 10, 1) },
    ];

    const run = new TurnDriver(t.deps).runTurn(mkInput({ toolExecutionMode: undefined }), {
      signal: new AbortController().signal,
    });
    await until(() => t.executor.executions.length === 2); // parallel dep honored
    alpha.resolve({ output: 'a', isError: false });
    beta.resolve({ output: 'b', isError: false });
    await run;
  });
});

describe('TurnDriver — queued message never aborts in-flight tools', () => {
  it('the in-flight tool completes with its REAL result; the turn still breaks at step_end', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    let release!: () => void;
    t.executor.behave(
      'slow',
      () =>
        new Promise((res) => {
          release = () => res({ output: 'ok:slow', isError: false });
        }),
    );
    t.llm.scripts = [
      { toolCalls: [tc('call_s', 'slow', {})], response: r('tool_calls', 10, 1) },
    ];

    let pending = 0;
    const run = new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
      getPendingItemCount: () => pending,
    });
    await until(() => t.executor.executions.length === 1);
    pending = 1; // a queued user message lands while the tool is in flight
    release(); // the tool settles on its own — nothing aborted it

    const result = await run;

    // Only ONE LLM call — the turn was cut short at step_end.
    expect(t.llm.calls.length).toBe(1);
    // The in-flight tool kept its REAL result — no synthesized cancellation.
    const part = t.store.partByCallId('call_s')!;
    expect(part.state.status).toBe('completed');
    expect((part.state as { output?: string }).output).toBe('ok:slow');
    // The interrupted turn resolves with the step's assistant message, not undefined:
    // ChannelWorker.item.resolve(result) feeds awaitCompletion() → markUserMessageDone(assistantId).
    expect(result).toBeDefined();
    expect(result.info.id).toBe('message_turn_1');
    // Cleanup ran on this exit path too.
    expect(phases(t.events).at(-1)).toBe('idle');
  }, 10000);

  it('sequential: the not-yet-started sibling tool ALSO runs to completion', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    let release!: () => void;
    t.executor.behave(
      'slow',
      () =>
        new Promise((res) => {
          release = () => res({ output: 'ok:slow', isError: false });
        }),
    );
    t.executor.behave('after', async () => ({ output: 'ok:after', isError: false }));
    t.llm.scripts = [
      {
        toolCalls: [tc('call_s', 'slow', {}), tc('call_a', 'after', {})],
        response: r('tool_calls', 10, 1),
      },
    ];

    let pending = 0;
    const run = new TurnDriver(t.deps).runTurn(mkInput({ toolExecutionMode: 'sequential' }), {
      signal: new AbortController().signal,
      getPendingItemCount: () => pending,
    });
    await until(() => t.executor.executions.length === 1);
    pending = 1;
    release();
    await run;

    // BOTH tools reached the executor and kept their real results (INV-1 holds).
    expect(t.executor.executions.map((e) => e.name)).toEqual(['slow', 'after']);
    for (const [callId, output] of [
      ['call_s', 'ok:slow'],
      ['call_a', 'ok:after'],
    ] as const) {
      const part = t.store.partByCallId(callId)!;
      expect(part.state.status).toBe('completed');
      expect((part.state as { output?: string }).output).toBe(output);
    }
    // Still only one LLM call — the queued message cut the turn at step_end.
    expect(t.llm.calls.length).toBe(1);
  }, 10000);
});

describe('TurnDriver — post-dispatch callback flush (anti TER-42)', () => {
  it('awaits in-flight tool_complete callbacks before the next LLM step', async () => {
    // Survivor hunt T14: without the post-dispatch flushCallbacks() the next
    // LLM call races ahead of the async tool_complete handlers (the exact
    // TER-42 signature: backend broadcast lands after the turn moved on).
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok', isError: false }));
    const order: string[] = [];
    t.publisher.onStream(async (ev) => {
      if (ev.message.type === 'tool_complete') {
        await sleep(10); // a slow downstream handler (DB save + WS broadcast)
        order.push('tool_complete:settled');
      }
    });
    t.llm.scripts = [
      { toolCalls: [tc('call_1', 'search', {})], response: r('tool_calls', 10, 1) },
      { onText: ['fin'], response: r('end_turn', 10, 1) },
    ];
    const orig = t.llm.streamMessage.bind(t.llm);
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = async (
      opts: StreamMessageOptions,
    ) => {
      order.push(`llm-call-${t.llm.calls.length + 1}:start`);
      return orig(opts);
    };

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    expect(order).toEqual(['llm-call-1:start', 'tool_complete:settled', 'llm-call-2:start']);
  });
});

describe('TurnDriver — lock aborted before dispatch (TER-445 fix)', () => {
  it('a lock aborted in the stream→dispatch window synthesizes cancellation WITHOUT executing', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'NO-ABORT-LEAK', isError: false }));
    const ac = new AbortController();
    t.llm.scripts = [
      { toolCalls: [tc('call_1', 'search', {})], response: r('tool_calls', 10, 1) },
      { throws: new Error('Request aborted') }, // the real adapter would reject on the aborted signal
    ];
    // Abort lands AFTER the LLM stream resolves but BEFORE tools dispatch.
    t.llm.afterCall = () => ac.abort();

    await expect(
      new TurnDriver(t.deps).runTurn(mkInput(), { signal: ac.signal }),
    ).rejects.toThrow('Request aborted');

    // The tool never reached the executor…
    expect(t.executor.executions).toEqual([]);
    // …and its tool_result was synthesized with the exact turn-abort message.
    const part = t.store.partByCallId('call_1')!;
    expect(part.state.status).toBe('error');
    expect((part.state as { error?: string }).error).toBe(
      'Tool execution cancelled: turn aborted.',
    );
  });
});

describe('TurnDriver — isPromptTooLongError matcher (each branch alone)', () => {
  const driver = () => new TurnDriver(mkDeps().deps) as unknown as {
    isPromptTooLongError(e: unknown): boolean;
  };
  const CASES: Array<[string, unknown, boolean]> = [
    ['context flag', { message: 'x', context: { isContextLengthError: true } }, true],
    ['prompt is too long', new Error('prompt is too long.'), true],
    ['tokens >', new Error('input length 250000 tokens > limit'), true],
    ['maximum', new Error('exceeds the model maximum'), true],
    ['context_length', new Error('error code: context_length_exceeded'), true],
    ['too long', new Error('input is too long for this model'), true],
    ['413', new Error('HTTP 413 Payload Too Large'), true],
    [
      'rawError + 400 + provider error',
      { message: 'Provider returned error (400)', context: { rawError: '...' } },
      true,
    ],
    ['unrelated error', new Error('rate limited, retry later'), false],
    ['400 without rawError context', { message: 'Provider returned error (400)' }, false],
    ['empty message', new Error(''), false],
  ];
  for (const [name, err, expected] of CASES) {
    it(`${name} → ${expected}`, () => {
      expect(driver().isPromptTooLongError(err)).toBe(expected);
    });
  }
});

describe('TurnDriver — max steps', () => {
  it('blocks tool execution once maxSteps is reached and clears the flag on exit', async () => {
    const t = mkDeps({ maxSteps: 1 });
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok', isError: false }));
    t.llm.scripts = [
      { toolCalls: [tc('call_1', 'search', {})], response: r('tool_calls', 10, 1) },
      { toolCalls: [tc('call_2', 'search', {})], response: r('tool_calls', 10, 1) },
      { onText: ['me detengo'], response: r('end_turn', 10, 1) },
    ];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    // Step 0 executed normally; step 1's tool was BLOCKED (never reached executor).
    expect(t.executor.executions.map((e) => e.options.toolCallId)).toEqual(['call_1']);
    const blocked = t.store.partByCallId('call_2')!;
    expect(blocked.state.status).toBe('error');
    expect((blocked.state as { error?: string }).error).toBe(
      'Tool execution blocked: maximum steps (1) reached. You have reached the execution limit. Add a progress note summarizing what you accomplished and what remains — this resets your execution counter so you can continue.',
    );
    // finally cleanup: the next turn must NOT inherit the stale flag.
    expect(t.deps.maxStepsReached.size).toBe(0);
  });
});

describe('TurnDriver — emergency compaction (prompt too long)', () => {
  it('compacts, persists the summary, reloads, and retries the LLM call', async () => {
    const t = mkDeps();
    seedMany(t.store, 12);
    const compaction = mkCompaction({
      success: true,
      summary: 'RESUMEN-EMERGENCIA',
      messagesCompacted: 2,
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    t.deps.compactionService = compaction.service;
    t.deps.compactionConfig = COMPACTION_CONFIG;
    t.llm.scripts = [
      { throws: new Error('prompt is too long.') },
      { onText: ['recuperado'], response: r('end_turn', 10, 1) },
    ];

    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });

    expect(t.llm.calls.length).toBe(2);
    expect(compaction.compactCalls.length).toBe(1);
    // Summary persisted with the exact compacted ids (the first 2 messages).
    expect(t.store.compactionUpdates).toEqual([
      [SESSION, 'RESUMEN-EMERGENCIA', ['message_u01', 'message_u02']],
    ]);
    expect(t.deps.sessionSummaries.get(SESSION)).toBe('RESUMEN-EMERGENCIA');
    // Retry uses the RELOADED window: −2 compacted, +2 synthetic summary PAIR
    // (buildPrompt injects the summary as a user+assistant synthetic exchange)
    // and +1 because the reload now sees the in-flight assistant skeleton that
    // processor.next() persisted before the failing LLM call.
    expect(t.llm.calls[1]!.messages.length).toBe(t.llm.calls[0]!.messages.length + 1);
    expect(JSON.stringify(t.llm.calls[1]!.messages)).toContain('RESUMEN-EMERGENCIA');
    expect(result.parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('falls back to aggressive truncation when compaction fails (keeps last 10, no summary)', async () => {
    const t = mkDeps();
    seedMany(t.store, 12);
    const compaction = mkCompaction({
      success: false,
      error: 'compactor down',
      messagesCompacted: 0,
      tokensBefore: 0,
      tokensAfter: 0,
    });
    t.deps.compactionService = compaction.service;
    t.deps.compactionConfig = COMPACTION_CONFIG;
    t.llm.scripts = [
      { throws: new Error('request failed: context_length_exceeded') },
      { onText: ['recuperado'], response: r('end_turn', 10, 1) },
    ];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    expect(t.llm.calls.length).toBe(2);
    // 12 messages → slice(-max(floor(12*0.3),10)) = last 10 → exactly 2 fewer.
    expect(t.llm.calls[1]!.messages.length).toBe(t.llm.calls[0]!.messages.length - 2);
    // No summary persisted on the truncation path.
    expect(t.store.compactionUpdates).toEqual([]);
    expect(t.deps.sessionSummaries.has(SESSION)).toBe(false);
  });

  it('rethrows non-context-length errors without retrying (and still cleans up)', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    const compaction = mkCompaction({
      success: true,
      summary: 'X',
      messagesCompacted: 1,
      tokensBefore: 1,
      tokensAfter: 1,
    });
    t.deps.compactionService = compaction.service;
    t.deps.compactionConfig = COMPACTION_CONFIG;
    t.llm.scripts = [{ throws: new Error('rate limited, retry later') }];

    await expect(
      new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal }),
    ).rejects.toThrow('rate limited, retry later');
    expect(t.llm.calls.length).toBe(1);
    expect(compaction.compactCalls.length).toBe(0);
    expect(phases(t.events).at(-1)).toBe('idle'); // belt-and-braces finally
    expect(t.deps.maxStepsReached.size).toBe(0);
  });

  it('rethrows context-length errors when no compaction service is wired', async () => {
    const t = mkDeps(); // no compactionService
    t.store.seedUserMessage('message_u01', 'hola');
    t.llm.scripts = [{ throws: new Error('prompt is too long') }];
    await expect(
      new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal }),
    ).rejects.toThrow('prompt is too long');
    expect(t.llm.calls.length).toBe(1);
  });
});

describe('TurnDriver — INV-1 reconcile on load', () => {
  it('remediates an orphan tool_use via the REAL chain (detect → synthesize → reload)', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.store.seedOrphanAssistant('message_orphan', 'call_orphan');
    t.llm.scripts = [{ onText: ['ok'], response: r('end_turn', 10, 1) }];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    // The orphan was remediated IN THE STORE before calling the LLM.
    const remediated = t.store.partByCallId('call_orphan')!;
    expect(remediated.state.status).toBe('error');
    expect((remediated.state as { error?: string }).error).toBe(
      'Tool execution did not complete (auto-recovered by INV-1 guard).',
    );
    expect((remediated as { meta?: { synthetic?: boolean } }).meta?.synthetic).toBe(true);
    // Load happened twice: initial + post-synthesis reload.
    expect(t.store.getMessagesCalls).toBe(2);
    // The LLM never saw a running orphan.
    const sentToolParts = t.llm.calls[0]!.messages
      .flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool');
    expect(sentToolParts.every((p) => p.state.status === 'error')).toBe(true);
  });
});

describe('TurnDriver — tool-arg eviction projection (TER-707 / CTX-016), I1', () => {
  it('I1-a: the LLM sees the elided value (key intact); callID/output survive; checkNeedsCompaction sees the SAME projection', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    const bigBody = 'w'.repeat(100_000);
    await seedCompletedTool(t.store, 'message_big', 'call_big', { path: '/f.ts', body: bigBody }, 'wrote 100000 bytes');

    let compactionSawMessages: MessageWithParts[] | undefined;
    t.deps.compactionService = {
      checkNeedsCompaction: (messages: MessageWithParts[]) => {
        compactionSawMessages = messages;
        return { shouldCompact: false, currentTokens: 0, threshold: 1000, protectedTokens: 0 };
      },
      compact: async () => ({ success: false, messagesCompacted: 0, tokensBefore: 0, tokensAfter: 0 }),
    } as unknown as CompactionService;
    t.deps.compactionConfig = COMPACTION_CONFIG;

    t.llm.scripts = [{ onText: ['ok'], response: r('end_turn', 10, 1) }];
    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    const sentPart = t.llm.calls[0]!.messages
      .flatMap((m) => m.parts)
      .find((p): p is ToolPart => p.type === 'tool' && p.callID === 'call_big')!;
    const sentInput = (sentPart.state as { input: Record<string, unknown> }).input;
    // (i) key preserved intact, long value elided:
    expect(sentInput.path).toBe('/f.ts');
    expect(sentInput.body).not.toBe(bigBody);
    expect((sentInput.body as string).length).toBeLessThan(bigBody.length);
    // (ii) callID and output survive:
    expect(sentPart.callID).toBe('call_big');
    expect((sentPart.state as { output?: string }).output).toBe('wrote 100000 bytes');
    // (iii) checkNeedsCompaction already saw the PROJECTED window (elided, not raw):
    const compactionInput = compactionSawMessages!
      .flatMap((m) => m.parts)
      .find((p): p is ToolPart => p.type === 'tool' && p.callID === 'call_big')!
      .state as { input: Record<string, unknown> };
    expect(compactionInput.input.body).not.toBe(bigBody);
  });

  it('I1-b: the retry reload ALSO returns projected messages, not raw', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    const bigBody = 'w'.repeat(100_000);
    await seedCompletedTool(t.store, 'message_big', 'call_big', { path: '/f.ts', body: bigBody });

    const compaction = mkCompaction({
      success: true,
      summary: 'RESUMEN',
      messagesCompacted: 0,
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    t.deps.compactionService = compaction.service;
    t.deps.compactionConfig = COMPACTION_CONFIG;
    t.llm.scripts = [
      { throws: new Error('prompt is too long.') },
      { onText: ['recuperado'], response: r('end_turn', 10, 1) },
    ];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    expect(t.llm.calls.length).toBe(2);
    const retryPart = t.llm.calls[1]!.messages
      .flatMap((m) => m.parts)
      .find((p): p is ToolPart => p.type === 'tool' && p.callID === 'call_big');
    expect(retryPart).toBeDefined();
    const retryInput = (retryPart!.state as { input: Record<string, unknown> }).input;
    expect(retryInput.body).not.toBe(bigBody);
  });

  it('I1-c: the retry reload ALSO remediates INV-1 — no non-terminal parts reach the LLM', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');

    const compaction = mkCompaction({
      success: true,
      summary: 'RESUMEN',
      messagesCompacted: 0,
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    t.deps.compactionService = compaction.service;
    t.deps.compactionConfig = COMPACTION_CONFIG;

    const calls: StreamMessageOptions[] = [];
    let callCount = 0;
    t.deps.llmClient = {
      streamMessage: async (options: StreamMessageOptions) => {
        calls.push(options);
        callCount++;
        if (callCount === 1) {
          // Simulates a step that crashed AFTER its own load/projection ran but
          // BEFORE the LLM call returned: an orphan `running` tool part lands
          // in the store DURING this failing call, so step 0's own load never
          // saw it — only the retry's reload can catch it.
          t.store.seedOrphanAssistant('message_orphan', 'call_orphan');
          throw new Error('prompt is too long.');
        }
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } };
      },
    } as unknown as ILLMClient;

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    expect(calls.length).toBe(2);
    const retryToolParts = calls[1]!.messages
      .flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool');
    expect(retryToolParts.every((p) => p.state.status !== 'running')).toBe(true);
    const orphanPart = retryToolParts.find((p) => p.callID === 'call_orphan');
    expect(orphanPart).toBeDefined();
    expect(orphanPart!.state.status).toBe('error');
  });

  it('I1-d: kill-switch off — the LLM receives RAW args, unbounded', async () => {
    const t = mkDeps({ toolArgEviction: false });
    t.store.seedUserMessage('message_u01', 'hola');
    const bigBody = 'w'.repeat(100_000);
    await seedCompletedTool(t.store, 'message_big', 'call_big', { path: '/f.ts', body: bigBody });
    t.llm.scripts = [{ onText: ['ok'], response: r('end_turn', 10, 1) }];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    const sentPart = t.llm.calls[0]!.messages
      .flatMap((m) => m.parts)
      .find((p): p is ToolPart => p.type === 'tool' && p.callID === 'call_big')!;
    const sentInput = (sentPart.state as { input: Record<string, unknown> }).input;
    expect(sentInput.body).toBe(bigBody);
  });
});

describe('TurnDriver — memory hooks (best-effort)', () => {
  it('beforeResponse runs only on step 0; afterResponse gets the exact turn summary', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok', isError: false }));
    t.llm.scripts = [
      { toolCalls: [tc('call_1', 'search', {})], response: r('tool_calls', 10, 1) },
      { onText: ['respuesta final'], response: r('end_turn', 10, 1) },
    ];

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    expect(t.memoryCalls.before).toEqual(['hola']); // once, despite 2 steps
    expect(t.memoryCalls.after).toEqual([
      [
        'hola',
        'respuesta final',
        { sessionId: SESSION, context: 'channel-ch_1', toolsCalled: [] },
        // TER-650: memory hooks now receive an abort signal so a hung Qdrant
        // call can be cancelled by the turn's hook deadline.
        { signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it('a throwing beforeResponse does not break the turn', async () => {
    const t = mkDeps();
    t.store.seedUserMessage('message_u01', 'hola');
    t.deps.memoryHooks = {
      beforeResponse: async () => {
        throw new Error('memory down');
      },
      afterResponse: async () => undefined,
    } as unknown as IMemoryHooks;
    t.llm.scripts = [{ onText: ['ok'], response: r('end_turn', 10, 1) }];
    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });
    expect(result.info.id).toBe('message_turn_1');
  });
});

describe('TurnDriver — LLM stall timeout (TER-650)', () => {
  it('aborts a frozen stream as a timeout (network_error), not a user abort', async () => {
    // A stream that never emits a first token is a TTFT stall → bound by the
    // first-chunk window. Set it short so the test is fast.
    const t = mkDeps({ llmTtftTimeoutMs: 30 });
    t.store.seedUserMessage('message_u01', 'hola');
    // Stream that opens but never emits a token, never settles, and ignores the
    // abort signal — the exact phantom-session condition. Pre-TER-650 this hung
    // the turn until the reconciler closed it ~20 min later and billed it.
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = () =>
      new Promise(() => {});

    let caught: unknown;
    try {
      await new TurnDriver(t.deps).runTurn(mkInput(), {
        signal: new AbortController().signal,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OperationTimeoutError);
    // Classifies as network_error (a frozen socket), NOT aborted_by_user — so
    // the session ends `errored` with 0 tokens and the billing safety net drops
    // it. The name has no "abort"/"interrupt" substring the classifier keys on.
    expect((caught as { context?: { errorClass?: string } }).context?.errorClass).toBe(
      'connection',
    );
    expect((caught as Error).name).toBe('OperationTimeoutError');
    // The turn never reached tool dispatch.
    expect(t.executor.executions).toEqual([]);
  });

  it('does not trip a slow-but-streaming turn (tokens keep resetting the timer)', async () => {
    const t = mkDeps({ llmStallTimeoutMs: 40 });
    t.store.seedUserMessage('message_u01', 'hola');
    // Emit a chunk every 15ms for ~90ms (> the 40ms window) then finish. The
    // stall must never trip because each chunk kicks the timer.
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = async (
      opts: StreamMessageOptions,
    ) => {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        await opts.callbacks?.onText?.('x');
      }
      await opts.callbacks?.onTextEnd?.();
      return r('end_turn', 10, 1);
    };
    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });
    expect(result.parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('does not trip when only thinking deltas stream, then finishes (reasoning heartbeat, TER-650)', async () => {
    // The model emits ONLY thinking (no text/tool) for well past the inter-token
    // window, then answers. Pre-heartbeat (H2) this read as a frozen socket and
    // was killed as a timeout; now onThinking → onProgress keeps the guard alive.
    // TTFT 60ms covers the first delta (15ms); inter-token 30ms is shorter than
    // the total thinking span (90ms) — so without the heartbeat this WOULD trip.
    const t = mkDeps({ llmTtftTimeoutMs: 60, llmStallTimeoutMs: 30 });
    t.store.seedUserMessage('message_u01', 'hola');
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = async (
      opts: StreamMessageOptions,
    ) => {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        await opts.callbacks?.onThinking?.('reasoning…');
      }
      await opts.callbacks?.onText?.('respuesta');
      await opts.callbacks?.onTextEnd?.();
      return r('end_turn', 10, 1);
    };
    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });
    expect(result.parts.some((p) => p.type === 'text' && (p as { text: string }).text === 'respuesta')).toBe(true);
  });

  it('does not trip while a large tool call streams its input (tool-args heartbeat, TER-650)', async () => {
    // Adapters buffer tool input and only fire onToolCall at stream end, so a
    // model writing big tool arguments emits NO text/thinking for the whole
    // span. Pre-heartbeat this read as a frozen socket and killed a live stream
    // ("llm-stream timed out after 60000ms" in prod); now onToolInputDelta →
    // onProgress keeps the guard alive. The text chunk first switches the guard
    // to the short inter-token window (30ms), then the tool args span 90ms —
    // without the heartbeat this WOULD trip.
    const t = mkDeps({ llmTtftTimeoutMs: 60, llmStallTimeoutMs: 30 });
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok', isError: false }));
    let step = 0;
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = async (
      opts: StreamMessageOptions,
    ) => {
      if (step++ > 0) {
        await opts.callbacks?.onText?.('listo');
        await opts.callbacks?.onTextEnd?.();
        return r('end_turn', 10, 1);
      }
      await opts.callbacks?.onText?.('déjame buscar');
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        await opts.callbacks?.onToolInputDelta?.('{"query":"…"');
      }
      await opts.callbacks?.onTextEnd?.();
      await opts.callbacks?.onToolCall?.(tc('call_1', 'search', { query: '…' }));
      return r('tool_calls', 10, 1);
    };
    const result = await new TurnDriver(t.deps).runTurn(mkInput(), {
      signal: new AbortController().signal,
    });
    // The stall guard never tripped: the tool executed and the turn completed.
    expect(t.executor.executions.map((e) => e.name)).toContain('search');
    expect(result.info.id).toBeDefined();
  });

  it('aborts a turn that outruns the absolute deadline as a timeout, not a user abort (TER-650)', async () => {
    // A stream that keeps emitting tokens (so the per-stream stall guard never
    // fires) but never finishes — only the absolute turn deadline can cut it.
    // Must reject with OperationTimeoutError (→ network_error), never
    // aborted_by_user. Emits every 10ms via an interval and unwinds on the
    // deadline-derived abort so no timer leaks past the test.
    const t = mkDeps({ turnDeadlineMs: 40 });
    t.store.seedUserMessage('message_u01', 'hola');
    (t.deps.llmClient as { streamMessage: unknown }).streamMessage = (
      opts: StreamMessageOptions,
    ) =>
      new Promise((_resolve, reject) => {
        const iv = setInterval(() => {
          void opts.callbacks?.onText?.('x');
        }, 10);
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearInterval(iv);
            reject(opts.signal?.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });

    let caught: unknown;
    try {
      await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });
    } catch (e) {
      caught = e;
    }
    // The deadline (40ms) fires long before any natural end. withOperationTimeout
    // force-rejects with the timeout regardless of when the stream unwinds.
    expect(caught).toBeInstanceOf(OperationTimeoutError);
    expect((caught as { context?: { errorClass?: string } }).context?.errorClass).toBe('connection');
    expect((caught as Error).name).toBe('OperationTimeoutError');
    expect((caught as { operation?: string }).operation).toBe('turn-deadline');
  });
});

describe('TurnAccumulator', () => {
  it('recordUsage accumulates across steps (missing fields count as 0)', () => {
    const acc = new TurnAccumulator();
    acc.recordUsage({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 });
    acc.recordUsage({ inputTokens: 50, cacheCreationInputTokens: 7 });
    acc.recordUsage(undefined);
    expect(acc.getUsage()).toEqual({
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      reasoningTokens: 0, // TER-615: new accumulator field, 0 when no provider reports it
    });
  });

  it('setBreakdownIfFirst scales by realInput/estimated and is idempotent', () => {
    const acc = new TurnAccumulator();
    const base = {
      system: 100,
      tools: 0,
      examples: 0,
      summary: 0,
      memory: 0,
      latest: 100,
      conversation: 50, // NOT part of totalFromBreakdown — scaled anyway
    };
    // estimated total = 200 (system+latest); real = 400 → factor 2.
    const scaled = acc.setBreakdownIfFirst(base, 400, 33);
    expect(scaled).toEqual({
      system: 200,
      tools: 0,
      examples: 0,
      summary: 0,
      previous: 0,
      memory: 0,
      context: 0,
      latest: 200,
      conversation: 100,
      toolCalls: 0,
      toolResults: 0,
      output: 33,
    });
    expect(acc.getBreakdown()).toEqual(scaled);
    // Second call is a no-op.
    expect(acc.setBreakdownIfFirst(base, 800, 99)).toBeUndefined();
    expect(acc.getBreakdown()).toEqual(scaled);
  });

  it('setBreakdownIfFirst with realInputTokens<=0 records nothing', () => {
    const acc = new TurnAccumulator();
    expect(
      acc.setBreakdownIfFirst(
        { system: 1, tools: 0, examples: 0, summary: 0, memory: 0, conversation: 0 },
        0,
        5,
      ),
    ).toBeUndefined();
    expect(acc.getBreakdown()).toBeUndefined();
  });

  it('getToolCalls returns undefined when empty (not [])', () => {
    const acc = new TurnAccumulator();
    expect(acc.getToolCalls()).toBeUndefined();
    acc.recordToolCalls([
      { toolCallId: 'c1', toolName: 't', status: 'completed' },
    ]);
    expect(acc.getToolCalls()).toEqual([
      { toolCallId: 'c1', toolName: 't', status: 'completed' },
    ]);
  });
});

describe('TurnDriver.runTurn — wrapper telemetry fallback (TER-615 follow-up)', () => {
  it('measures ttft/latency in the wrapper when the adapter emits no onFinish', async () => {
    // BYOK adapters (anthropic / openai / gemini / …) never call onFinish, so
    // before this fix latencyMs/ttftMs stayed undefined → Model Health blank.
    // The wrapper now measures wall-clock around the call. Drive the injected
    // clock from inside streamMessage to assert exact figures.
    let fakeNow = 5_000_000;
    const t = mkDeps({ clock: { now: () => fakeNow } });
    t.store.seedUserMessage('message_u01', 'hola');
    const byokClient = {
      getProviderInfo: () => ({
        name: 'anthropic',
        model: 'claude',
        capabilities: { streaming: true, tools: false, thinking: false, vision: false },
      }),
      async streamMessage(opts: StreamMessageOptions): Promise<LLMResponse> {
        fakeNow += 40; // 40 ms to the first streamed chunk → TTFT
        await opts.callbacks?.onText?.('hola!');
        await opts.callbacks?.onTextEnd?.();
        fakeNow += 60; // 60 ms more before returning → 100 ms total latency
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    (t.deps as { llmClient: ILLMClient }).llmClient = byokClient as unknown as ILLMClient;

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    const meta = (t.completions[0] as Record<string, unknown>)
      .responseMetadata as Record<string, unknown>;
    expect(meta.ttftMs).toBe(40);
    expect(meta.latencyMs).toBe(100);
    expect(meta.finishReason).toBe('end_turn');
  });

  it('lets the adapter-reported onFinish latency win over the wrapper measurement', async () => {
    // When the adapter DOES emit onFinish (OpenAI-compatible), its figures are
    // canonical — the wrapper must not override or double-count them.
    let fakeNow = 9_000_000;
    const t = mkDeps({ clock: { now: () => fakeNow } });
    t.store.seedUserMessage('message_u01', 'hola');
    const emittingClient = {
      getProviderInfo: () => ({
        name: 'teros',
        model: 'kimi',
        capabilities: { streaming: true, tools: false, thinking: false, vision: false },
      }),
      async streamMessage(opts: StreamMessageOptions): Promise<LLMResponse> {
        fakeNow += 40; // the wrapper would measure 40 ttft / 100 latency…
        await opts.callbacks?.onText?.('hola!');
        await opts.callbacks?.onTextEnd?.();
        fakeNow += 60;
        // …but the adapter reports its own, more precise figures.
        await opts.callbacks?.onFinish?.({
          ttftMs: 7,
          latencyMs: 123,
          actualProvider: 'fireworks',
        });
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    (t.deps as { llmClient: ILLMClient }).llmClient = emittingClient as unknown as ILLMClient;

    await new TurnDriver(t.deps).runTurn(mkInput(), { signal: new AbortController().signal });

    const meta = (t.completions[0] as Record<string, unknown>)
      .responseMetadata as Record<string, unknown>;
    expect(meta.ttftMs).toBe(7); // adapter, not the wrapper's 40
    expect(meta.latencyMs).toBe(123); // adapter, not the wrapper's 100
    expect(meta.actualProvider).toBe('fireworks');
  });
});

// ---------------------------------------------------------------------------
// Fakes — faithful to the real boundaries.
// ---------------------------------------------------------------------------

/**
 * Live in-memory SessionStore: upsert-by-id with snapshots at write time, so
 * reloads (INV-1, post-compaction) observe exactly what was persisted.
 * updateCompactionSummary drops compacted messages — replicating the
 * compaction-boundary behavior of MongoSessionStore.
 */
class FakeSessionStore {
  private messages = new Map<string, Record<string, unknown>>();
  private parts = new Map<string, Part>();
  summaryToReturn?: string;
  getMessagesCalls = 0;
  compactionUpdates: Array<[string, string, string[]]> = [];

  seedUserMessage(id: string, text: string): void {
    this.messages.set(id, {
      id,
      sessionID: SESSION,
      role: 'user',
      time: { created: Date.now() },
    });
    this.parts.set(`part_${id}`, {
      id: `part_${id}`,
      sessionID: SESSION,
      messageID: id,
      type: 'text',
      text,
      time: { start: Date.now(), end: Date.now() },
    } as Part);
  }

  seedOrphanAssistant(id: string, callID: string): void {
    this.messages.set(id, {
      id,
      sessionID: SESSION,
      role: 'assistant',
      time: { created: Date.now() },
      system: [],
      modelID: '',
      providerID: '',
      mode: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.parts.set(`part_${callID}`, {
      id: `part_${callID}`,
      sessionID: SESSION,
      messageID: id,
      type: 'tool',
      tool: 'search',
      callID,
      state: { status: 'running', input: {}, time: { start: Date.now() } },
    } as ToolPart);
  }

  async getMessagesForLLM(_sessionId: string): Promise<{
    summary?: string;
    messages: MessageWithParts[];
  }> {
    this.getMessagesCalls += 1;
    return { summary: this.summaryToReturn, messages: this.snapshot() };
  }

  private snapshot(): MessageWithParts[] {
    return [...this.messages.values()].map((info) => ({
      info: structuredClone(info),
      parts: [...this.parts.values()]
        .filter((p) => p.messageID === (info as { id: string }).id)
        .map((p) => structuredClone(p)),
    })) as unknown as MessageWithParts[];
  }

  async writeMessage(m: { id: string }): Promise<void> {
    this.messages.set(m.id, structuredClone(m) as Record<string, unknown>);
  }

  async writePart(p: Part): Promise<void> {
    this.parts.set(p.id, structuredClone(p));
  }

  async listParts(messageId: string): Promise<Part[]> {
    return [...this.parts.values()]
      .filter((p) => p.messageID === messageId)
      .map((p) => structuredClone(p));
  }

  async updateCompactionSummary(
    sessionId: string,
    summary: string,
    compactedIds: string[],
  ): Promise<void> {
    this.compactionUpdates.push([sessionId, summary, compactedIds]);
    for (const id of compactedIds) this.messages.delete(id);
    this.summaryToReturn = summary;
  }

  async touchSession(): Promise<void> {}

  partByCallId(callID: string): ToolPart | undefined {
    return [...this.parts.values()].find(
      (p): p is ToolPart => p.type === 'tool' && p.callID === callID,
    );
  }
}

type TurnScript =
  | { onText?: string[]; toolCalls?: ToolCall[]; response: LLMResponse }
  | { throws: Error };

/** Scripted LLM: drives the real streaming callbacks, then returns the response. */
class ScriptedLLMClient {
  scripts: TurnScript[] = [];
  calls: StreamMessageOptions[] = [];
  /** Fires right after a scripted call returns — lets tests hit the stream→dispatch window. */
  afterCall?: () => void;

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    this.calls.push(options);
    const script = this.scripts.shift();
    if (!script) throw new Error(`ScriptedLLMClient: no script for call #${this.calls.length}`);
    if ('throws' in script) throw script.throws;
    for (const chunk of script.onText ?? []) await options.callbacks?.onText?.(chunk);
    if (script.onText?.length) await options.callbacks?.onTextEnd?.();
    for (const toolCall of script.toolCalls ?? []) {
      await options.callbacks?.onToolCall?.(toolCall);
    }
    this.afterCall?.();
    return script.response;
  }
}

type ToolBehavior = (
  input: Record<string, unknown>,
  options: ToolExecutionOptions,
) => Promise<ToolExecutionResult>;

class FakeToolExecutor {
  tools = [mkTool('search'), mkTool('alpha'), mkTool('beta'), mkTool('hang'), mkTool('never')];
  executions: Array<{
    name: string;
    input: Record<string, unknown>;
    options: ToolExecutionOptions;
  }> = [];
  private behaviors = new Map<string, ToolBehavior>();

  behave(name: string, behavior: ToolBehavior): void {
    this.behaviors.set(name, behavior);
  }

  getTools() {
    return this.tools;
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
    options: ToolExecutionOptions = {},
  ): Promise<ToolExecutionResult> {
    this.executions.push({ name, input, options });
    const behavior = this.behaviors.get(name);
    if (!behavior) return { output: `ok:${name}`, isError: false };
    return behavior(input, options);
  }
}

const COMPACTION_CONFIG = {
  triggerAt: 1000,
  targetSize: 600,
  protectRecent: 100,
  contextSize: 2000,
};

function mkCompaction(result: {
  success: boolean;
  summary?: string;
  error?: string;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
}) {
  const compactCalls: MessageWithParts[][] = [];
  const service = {
    checkNeedsCompaction: () => ({
      shouldCompact: false,
      currentTokens: 0,
      threshold: 1000,
      protectedTokens: 0,
    }),
    compact: async (messages: MessageWithParts[]) => {
      compactCalls.push(messages);
      return result;
    },
  } as unknown as CompactionService;
  return { service, compactCalls };
}

function mkDeps(overrides: Partial<TurnDriverDeps> = {}) {
  const store = new FakeSessionStore();
  const llm = new ScriptedLLMClient();
  const executor = new FakeToolExecutor();
  const events: StreamEvent[] = [];
  const completions: unknown[] = [];
  const memoryCalls = { before: [] as string[], after: [] as unknown[] };

  const publisher = new StreamPublisher('agent_test', {
    enabled: true,
    throttleMs: 0,
    maxChunkSize: 1,
  });
  publisher.onStream((ev) => {
    events.push(structuredClone(ev) as StreamEvent);
  });
  publisher.onMessageComplete((data) => {
    completions.push(structuredClone(data));
  });

  const deps: TurnDriverDeps = {
    sessionStore: store as unknown as SessionStore,
    llmClient: llm as unknown as ILLMClient,
    toolExecutor: executor,
    memoryHooks: {
      beforeResponse: async (userText: string) => {
        memoryCalls.before.push(userText);
        return '';
      },
      afterResponse: async (...args: unknown[]) => {
        memoryCalls.after.push(args);
      },
    } as unknown as IMemoryHooks,
    streamPublisher: publisher,
    agentId: 'agent_test',
    cacheBlockSize: 0,
    maxSteps: 5,
    interruptStrategy: boundaryAware,
    maxStepsReached: new Map(),
    stepResetRequested: new Map(),
    sessionSummaries: new Map(),
    toolExecutionMode: 'sequential',
    // Deterministic clock so the wrapper-measured latency/ttft (TER-615
    // follow-up) is 0 by default → the timing fallback stays silent and these
    // tests keep asserting only the adapter/metadata telemetry. Override per
    // test to drive real wrapper timing.
    clock: { now: () => FIXED_NOW },
    ...overrides,
  };
  return { deps, store, llm, executor, publisher, events, completions, memoryCalls };
}

function mkInput(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    sessionID: SESSION,
    userId: 'user_1',
    channelId: 'ch_1',
    parts: [{ type: 'text', text: 'hola' }],
    assistantTurnId: 'message_turn_1',
    systemPrompt: 'eres un agente de test',
    sessionUsageId: 'usage_1',
    ...overrides,
  };
}

function mkTool(name: string) {
  return {
    name,
    description: 'test tool',
    input_schema: { type: 'object' as const, properties: {} },
  };
}

function tc(id: string, name: string, input: Record<string, unknown>): ToolCall {
  return { id, name, input: input as Record<string, any> };
}

function r(
  stopReason: LLMResponse['stopReason'],
  inputTokens: number,
  outputTokens: number,
): LLMResponse {
  return { stopReason, usage: { inputTokens, outputTokens } };
}

function seedMany(store: FakeSessionStore, n: number): void {
  for (let i = 1; i <= n; i++) {
    store.seedUserMessage(`message_u${String(i).padStart(2, '0')}`, `mensaje ${i}`);
  }
}

/** Seeds a COMPLETED assistant tool-call (TER-707/CTX-016 fixtures). */
async function seedCompletedTool(
  store: FakeSessionStore,
  messageId: string,
  callID: string,
  input: unknown,
  output = 'ok',
): Promise<void> {
  await store.writeMessage({
    id: messageId,
    sessionID: SESSION,
    role: 'assistant',
    time: { created: Date.now() },
    system: [],
    modelID: '',
    providerID: '',
    mode: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await store.writePart({
    id: `part_${callID}`,
    sessionID: SESSION,
    messageID: messageId,
    type: 'tool',
    tool: 'filesystem_write',
    callID,
    state: {
      status: 'completed',
      input,
      output,
      title: 't',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  } as ToolPart);
}

function phases(events: StreamEvent[]): string[] {
  return events
    .filter((e) => e.message.type === 'agent_phase')
    .map((e) => (e.message as { phase: string }).phase);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await sleep(5);
  }
}

describe('TurnDriver — mid-turn billing cut (FASE 0.5)', () => {
  it('blocks the next LLM call when billingGate throws, without finishing the turn', async () => {
    let billingCalls = 0;
    let lastUserId = '';
    const billingGate = async (userId: string) => {
      billingCalls++;
      lastUserId = userId;
      throw new Error('HOURS_EXHAUSTED');
    };
    const t = mkDeps({ billingGate });
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok:search', isError: false }));
    t.llm.scripts = [
      // step 0: tool_calls → would continue to step 1 (gate NOT called at step 0)
      { toolCalls: [tc('call_a', 'search', { q: 'x' })], response: r('tool_calls', 100, 10) },
      // step 1: must NEVER run — the mid-turn gate cuts before this LLM call
      { onText: ['fin'], response: r('end_turn', 50, 5) },
    ];

    const driver = new TurnDriver(t.deps);
    await expect(
      driver.runTurn(mkInput(), { signal: new AbortController().signal }),
    ).rejects.toThrow('HOURS_EXHAUSTED');

    // Only the first LLM call ran; the continuation was blocked mid-turn.
    expect(t.llm.calls.length).toBe(1);
    // Gate checked exactly once, at the start of step 1 (step > 0), with the turn's userId.
    expect(billingCalls).toBe(1);
    expect(lastUserId).toBe('user_1');
  });

  it('does not gate step 0 and lets the turn finish when billingGate passes', async () => {
    let billingCalls = 0;
    const billingGate = async () => {
      billingCalls++;
    };
    const t = mkDeps({ billingGate });
    t.store.seedUserMessage('message_u01', 'hola');
    t.executor.behave('search', async () => ({ output: 'ok:search', isError: false }));
    t.llm.scripts = [
      { toolCalls: [tc('call_a', 'search', { q: 'x' })], response: r('tool_calls', 100, 10) },
      { onText: ['fin'], response: r('end_turn', 50, 5) },
    ];

    const driver = new TurnDriver(t.deps);
    await driver.runTurn(mkInput(), { signal: new AbortController().signal });

    // Both LLM calls ran; gate checked once (only at step 1, never at step 0).
    expect(t.llm.calls.length).toBe(2);
    expect(billingCalls).toBe(1);
  });
});
