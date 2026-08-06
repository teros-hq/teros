/**
 * TurnDriver tests — end-to-end behaviour of a single conversation turn.
 *
 * Covers the observable surface of `runTurn(input, options)`:
 *   - text-only happy path returns a finished assistant `MessageWithParts`
 *   - tool_use → tool_result → text multi-step loop
 *   - `agent_phase` lifecycle: `thinking` at entry, `idle` in `finally`
 *   - AbortSignal mid-turn still emits `idle` (try/finally invariant)
 *   - max-steps injects an error tool_result so the LLM can terminate
 *   - `assistantTurnId` is honoured on the first assistant message
 *   - INV-1 remediation: orphan tool_use triggers `synthesizeOrphans`
 *
 * Mocks are minimal-by-design: a hand-rolled `SessionStore`-shaped store and
 * an `IToolExecutor` factory; both expose just the surface `TurnDriver`
 * touches. The LLM is driven by `createSimpleMockAdapter`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoOpMemoryHooks } from '../../src/memory';
import { boundaryAware, postTurnFifo } from '../../src/conversation/InterruptStrategy';
import { TurnDriver, type TurnDriverDeps } from '../../src/conversation/TurnDriver';
import type { PromptInput } from '../../src/conversation/ConversationManager';
import type { ILLMClient } from '../../src/llm/ILLMClient';
import { createSimpleMockAdapter } from '../../src/testing/LLMRecorder';
import type { SessionStore } from '../../src/session/SessionStore';
import type {
  AgentPhase,
  AssistantMessage,
  Message,
  MessageWithParts,
  Part,
  Session,
  TextPart,
  ToolPart,
} from '../../src/session/types';
import type { IToolExecutor, ToolExecutionResult } from '../../src/tools/IToolExecutor';
import { StreamPublisher, type StreamEvent } from '../../src/streaming';

// ───────────────────────────────────────────────────────────────────────────
// SessionStore stand-in — implements only what TurnDriver touches.
// ───────────────────────────────────────────────────────────────────────────
class FakeStore {
  public messages = new Map<string, Message>();
  public parts = new Map<string, Part>();
  public session: Session | undefined;

  setSession(s: Session) {
    this.session = s;
  }
  async getSession(): Promise<Session | undefined> {
    return this.session;
  }
  async writeSession(s: Session): Promise<void> {
    this.session = s;
  }
  async writeMessage(m: Message): Promise<void> {
    this.messages.set(m.id, { ...m });
  }
  async writePart(p: Part): Promise<void> {
    this.parts.set(p.id, { ...p });
  }
  async listParts(messageID: string): Promise<Part[]> {
    return Array.from(this.parts.values()).filter((p) => p.messageID === messageID);
  }
  async getMessagesWithParts(sessionID: string): Promise<MessageWithParts[]> {
    const msgs = Array.from(this.messages.values())
      .filter((m) => m.sessionID === sessionID)
      .sort((a, b) => a.time.created - b.time.created);
    return Promise.all(
      msgs.map(async (info) => ({ info, parts: await this.listParts(info.id) })),
    );
  }
  async getMessagesForLLM(sessionID: string) {
    const messages = await this.getMessagesWithParts(sessionID);
    return { summary: this.session?.compaction?.summary, messages };
  }
  async updateCompactionSummary(): Promise<void> {}
  async updateUserMessageQueueState(): Promise<void> {}
  async listPendingQueueMessages(): Promise<MessageWithParts[]> {
    return [];
  }
  async touchSession(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async listSessions(): Promise<Session[]> {
    return this.session ? [this.session] : [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tool executor factory — defaults to a single `echo` tool that returns the
// input verbatim. Override behaviour per-test.
// ───────────────────────────────────────────────────────────────────────────
function makeToolExecutor(
  overrides: Partial<IToolExecutor> = {},
  toolName = 'echo',
): IToolExecutor & { calls: Array<{ name: string; input: any }> } {
  const calls: Array<{ name: string; input: any }> = [];
  return {
    calls,
    getTools: () => [
      {
        name: toolName,
        description: 'test tool',
        input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
    ],
    async executeTool(name, input): Promise<ToolExecutionResult> {
      calls.push({ name, input });
      return { output: `executed:${name}`, isError: false };
    },
    ...overrides,
  } as IToolExecutor & { calls: Array<{ name: string; input: any }> };
}

// ───────────────────────────────────────────────────────────────────────────
// makeDriver() — assembles a TurnDriver with sensible defaults; callers
// override `llmClient`, `toolExecutor`, `streamPublisher`, `maxSteps`.
// ───────────────────────────────────────────────────────────────────────────
interface MakeDriverOpts {
  llmClient: ILLMClient;
  toolExecutor?: IToolExecutor;
  streamPublisher?: StreamPublisher;
  maxSteps?: number;
  toolExecutionMode?: 'sequential' | 'parallel';
}

function makeDriver(opts: MakeDriverOpts): {
  driver: TurnDriver;
  store: FakeStore;
  maxStepsReached: Map<string, boolean>;
  deps: TurnDriverDeps;
} {
  const store = new FakeStore();
  store.setSession({
    id: 'sess_test',
    userId: 'user_test',
    channelId: 'ch_test',
    title: 'test',
    time: { created: Date.now(), updated: Date.now() },
    transportType: 'channel' as any,
    transportData: {},
  });
  const maxStepsReached = new Map<string, boolean>();
  const sessionSummaries = new Map<string, string>();
  const deps: TurnDriverDeps = {
    sessionStore: store as unknown as SessionStore,
    llmClient: opts.llmClient,
    toolExecutor: opts.toolExecutor,
    memoryHooks: new NoOpMemoryHooks(),
    streamPublisher: opts.streamPublisher,
    cacheBlockSize: 20,
    maxSteps: opts.maxSteps ?? 10,
    interruptStrategy: boundaryAware,
    maxStepsReached,
    sessionSummaries,
    toolExecutionMode: opts.toolExecutionMode ?? 'sequential',
  };
  return { driver: new TurnDriver(deps), store, maxStepsReached, deps };
}

function makeInput(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    sessionID: 'sess_test',
    userId: 'user_test',
    channelId: 'ch_test',
    parts: [{ type: 'text', text: 'hello' }],
    systemPrompt: 'you are a test agent',
    ...overrides,
  };
}

// Build a StreamPublisher that captures every event for assertion.
function makeCapturingPublisher(): {
  publisher: StreamPublisher;
  events: StreamEvent[];
  phases: AgentPhase[];
} {
  const events: StreamEvent[] = [];
  const phases: AgentPhase[] = [];
  const publisher = new StreamPublisher('agent_test');
  publisher.onStream((evt) => {
    events.push(evt);
    if (evt.message.type === 'agent_phase') {
      phases.push((evt.message as { phase: AgentPhase }).phase);
    }
  });
  return { publisher, events, phases };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('TurnDriver.runTurn', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('text-only happy path returns an assistant MessageWithParts with TextPart', async () => {
    const llm = createSimpleMockAdapter([{ text: 'hi there!', stopReason: 'end_turn' }]);
    const { publisher } = makeCapturingPublisher();
    const { driver } = makeDriver({ llmClient: llm, streamPublisher: publisher });

    const ac = new AbortController();
    const result = await driver.runTurn(makeInput(), { signal: ac.signal });

    expect(result.info.role).toBe('assistant');
    expect(result.streamingUsed).toBe(true);
    const textParts = result.parts.filter((p) => p.type === 'text') as TextPart[];
    expect(textParts.length).toBe(1);
    expect(textParts[0].text).toBe('hi there!');
  });

  test('multi-step: tool_use then text invokes toolExecutor and ends with assistant text', async () => {
    const llm = createSimpleMockAdapter([
      {
        toolCalls: [{ id: 'call_1', name: 'echo', input: { msg: 'ping' } }],
        stopReason: 'tool_calls',
      },
      { text: 'all done', stopReason: 'end_turn' },
    ]);
    const exec = makeToolExecutor();
    const { driver } = makeDriver({ llmClient: llm, toolExecutor: exec });

    const ac = new AbortController();
    const result = await driver.runTurn(makeInput(), { signal: ac.signal });

    expect(exec.calls).toEqual([{ name: 'echo', input: { msg: 'ping' } }]);
    const finalText = (result.parts.find((p) => p.type === 'text') as TextPart | undefined)?.text;
    expect(finalText).toBe('all done');
  });

  // ── TER-386: tool execution mode (sequential default / parallel legacy) ──────
  // An executor that records start/end around a small async gap, so overlapping
  // (parallel) vs strictly-ordered (sequential) dispatch is observable.
  function makeOrderTrackingExecutor(): IToolExecutor & { events: string[] } {
    const events: string[] = [];
    return {
      events,
      getTools: () => [
        {
          name: 'work',
          description: 'order-tracking test tool',
          input_schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
      async executeTool(_name, input): Promise<ToolExecutionResult> {
        const id = (input as { id: string }).id;
        events.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`end:${id}`);
        return { output: `done:${id}`, isError: false };
      },
    } as IToolExecutor & { events: string[] };
  }

  function twoToolLLM(): ILLMClient {
    return createSimpleMockAdapter([
      {
        toolCalls: [
          { id: 'call_a', name: 'work', input: { id: 'A' } },
          { id: 'call_b', name: 'work', input: { id: 'B' } },
        ],
        stopReason: 'tool_calls',
      },
      { text: 'done', stopReason: 'end_turn' },
    ]);
  }

  test('sequential mode (default) runs tool calls one-by-one in array order, no overlap', async () => {
    const exec = makeOrderTrackingExecutor();
    const { driver } = makeDriver({
      llmClient: twoToolLLM(),
      toolExecutor: exec,
      toolExecutionMode: 'sequential',
    });

    await driver.runTurn(makeInput(), { signal: new AbortController().signal });

    // Each tool fully finishes before the next starts.
    expect(exec.events).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  test('parallel mode dispatches tool calls concurrently (overlapping)', async () => {
    const exec = makeOrderTrackingExecutor();
    const { driver } = makeDriver({
      llmClient: twoToolLLM(),
      toolExecutor: exec,
      toolExecutionMode: 'parallel',
    });

    await driver.runTurn(makeInput(), { signal: new AbortController().signal });

    // Both tools start before either ends → concurrent dispatch.
    expect(exec.events.slice(0, 2)).toEqual(['start:A', 'start:B']);
  });

  // TER-386 regression: a long-lived per-channel ChannelWorker (keyed by
  // channelId) reuses the turnDriver built on the turn that first created it,
  // freezing `deps.toolExecutionMode` at that turn's flag value. The mode is
  // therefore carried per-turn on the input (stamped by ConversationManager.prompt)
  // and MUST take precedence over the construction-time dep. Without this the
  // flag never switches once a conversation has had its first turn.
  test('per-turn input.toolExecutionMode overrides a stale dep — parallel input on a sequential-built driver', async () => {
    const exec = makeOrderTrackingExecutor();
    const { driver } = makeDriver({
      llmClient: twoToolLLM(),
      toolExecutor: exec,
      toolExecutionMode: 'sequential', // stale dep frozen by the reused worker
    });

    await driver.runTurn(makeInput({ toolExecutionMode: 'parallel' }), {
      signal: new AbortController().signal,
    });

    // input mode wins → concurrent dispatch despite the sequential dep.
    expect(exec.events.slice(0, 2)).toEqual(['start:A', 'start:B']);
  });

  test('per-turn input.toolExecutionMode overrides a stale dep — sequential input on a parallel-built driver', async () => {
    const exec = makeOrderTrackingExecutor();
    const { driver } = makeDriver({
      llmClient: twoToolLLM(),
      toolExecutor: exec,
      toolExecutionMode: 'parallel', // stale dep frozen by the reused worker
    });

    await driver.runTurn(makeInput({ toolExecutionMode: 'sequential' }), {
      signal: new AbortController().signal,
    });

    // input mode wins → strictly ordered, no overlap, despite the parallel dep.
    expect(exec.events).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  // ── Queue poller vs interrupt strategy ─────────────────────────────────────
  // The 500ms queue poller in dispatchToolsWithStepEndCheck must only abort
  // in-flight dispatch when the strategy would actually interrupt at step_end.
  // With post_turn_fifo (headless channels) a queued message sits in the worker
  // queue for the whole turn; aborting dispatch for a message the strategy will
  // not act on killed every in-flight tool — including ones whose permission
  // the user had just granted.
  function makeSignalProbeExecutor(
    runMs: number,
  ): IToolExecutor & { abortedDuringRun: boolean[] } {
    const abortedDuringRun: boolean[] = [];
    return {
      abortedDuringRun,
      getTools: () => [
        {
          name: 'slow',
          description: 'signal-probing test tool',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      async executeTool(_name, _input, options): Promise<ToolExecutionResult> {
        await new Promise((r) => setTimeout(r, runMs));
        abortedDuringRun.push(options?.signal?.aborted === true);
        return { output: 'done', isError: false };
      },
    } as IToolExecutor & { abortedDuringRun: boolean[] };
  }

  function slowToolLLM(): ILLMClient {
    return createSimpleMockAdapter([
      { toolCalls: [{ id: 'call_1', name: 'slow', input: {} }], stopReason: 'tool_calls' },
      { text: 'all done', stopReason: 'end_turn' },
    ]);
  }

  test('post_turn_fifo: a queued message does NOT abort in-flight tool dispatch', async () => {
    const exec = makeSignalProbeExecutor(700); // outlives the 500ms poller interval
    const { deps } = makeDriver({ llmClient: slowToolLLM(), toolExecutor: exec });
    const driver = new TurnDriver({ ...deps, interruptStrategy: postTurnFifo });

    const result = await driver.runTurn(makeInput(), {
      signal: new AbortController().signal,
      getPendingItemCount: () => 1, // message waiting in the worker queue all turn
    });

    expect(exec.abortedDuringRun).toEqual([false]);
    // The turn ran to completion — the queued item drains at turn_end, not mid-turn.
    const finalText = (result.parts.find((p) => p.type === 'text') as TextPart | undefined)?.text;
    expect(finalText).toBe('all done');
  });

  test('boundary_aware: a queued message aborts in-flight tool dispatch mid-flight', async () => {
    const exec = makeSignalProbeExecutor(700);
    const { driver } = makeDriver({ llmClient: slowToolLLM(), toolExecutor: exec });

    await driver.runTurn(makeInput(), {
      signal: new AbortController().signal,
      getPendingItemCount: () => 1,
    });

    expect(exec.abortedDuringRun).toEqual([true]);
  });

  test('agent_phase lifecycle: emits thinking on entry and idle in finally', async () => {
    const llm = createSimpleMockAdapter([{ text: 'ok', stopReason: 'end_turn' }]);
    const { publisher, phases } = makeCapturingPublisher();
    const { driver } = makeDriver({ llmClient: llm, streamPublisher: publisher });

    await driver.runTurn(makeInput(), { signal: new AbortController().signal });

    expect(phases[0]).toBe('thinking');
    expect(phases[phases.length - 1]).toBe('idle');
  });

  test('AbortSignal mid-turn: runTurn rejects and idle is still emitted', async () => {
    // LLM never streams a stop reason because we abort before it returns —
    // the mock adapter resolves synchronously, so we abort the signal
    // beforehand and let the LLM observe it. Either path lands in finally
    // and must publish idle.
    const ac = new AbortController();
    // Custom LLM that observes the signal during streaming.
    const llm: ILLMClient = {
      async streamMessage(opts) {
        // Wait for an abort that the test will trigger via microtask.
        await new Promise<void>((resolve, reject) => {
          if (opts.signal?.aborted) return reject(new Error('aborted'));
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          // Tick to let the test abort.
          setTimeout(() => resolve(), 50);
        });
        return { stopReason: 'end_turn' };
      },
      getProviderInfo: () => ({ name: 'mock', model: 'mock' }),
    };
    const { publisher, phases } = makeCapturingPublisher();
    const { driver } = makeDriver({ llmClient: llm, streamPublisher: publisher });

    const turnP = driver.runTurn(makeInput(), { signal: ac.signal });
    queueMicrotask(() => ac.abort(new Error('user-stop')));
    await expect(turnP).rejects.toBeDefined();

    expect(phases[0]).toBe('thinking');
    expect(phases[phases.length - 1]).toBe('idle');
  });

  test('max-steps reached injects an error tool_result so the LLM can terminate', async () => {
    // The maxStepsReached flag is set at the TOP of an iteration when
    // `step >= maxSteps`. With maxSteps=1, iteration 1 runs normally; on
    // iteration 2 the flag flips, and any tool_call dispatched in that
    // iteration is short-circuited with a synthetic error tool_result.
    // Sequence: tool_calls → tool_calls (blocked) → text end_turn.
    const llm = createSimpleMockAdapter([
      { toolCalls: [{ id: 'call_1', name: 'echo', input: {} }], stopReason: 'tool_calls' },
      { toolCalls: [{ id: 'call_2', name: 'echo', input: {} }], stopReason: 'tool_calls' },
      { text: 'giving up', stopReason: 'end_turn' },
    ]);
    const exec = makeToolExecutor();
    const { driver, store, maxStepsReached } = makeDriver({
      llmClient: llm,
      toolExecutor: exec,
      maxSteps: 1,
    });

    await driver.runTurn(makeInput(), { signal: new AbortController().signal });

    // The second tool was never executed; an error tool_result was
    // persisted instead. (The first tool runs because the flag is checked
    // at the TOP of the next iteration, not on the first dispatch.)
    expect(exec.calls.length).toBe(1);
    const toolParts = Array.from(store.parts.values()).filter(
      (p) => p.type === 'tool',
    ) as ToolPart[];
    const errored = toolParts.find((tp) => tp.state.status === 'error');
    expect(errored).toBeDefined();
    const errState = errored!.state as { status: 'error'; error: string };
    expect(errState.error).toMatch(/maximum steps/);
    // Successful turn deletes the flag on the way out — verifies the
    // cleanup branch on line 308 of TurnDriver.
    expect(maxStepsReached.has('sess_test')).toBe(false);
  });

  test('seed assistantTurnId is used as the first assistant message id', async () => {
    const llm = createSimpleMockAdapter([{ text: 'seeded', stopReason: 'end_turn' }]);
    const { driver, store } = makeDriver({ llmClient: llm });

    await driver.runTurn(makeInput({ assistantTurnId: 'message_test123' }), {
      signal: new AbortController().signal,
    });

    const assistants = Array.from(store.messages.values()).filter(
      (m) => m.role === 'assistant',
    ) as AssistantMessage[];
    expect(assistants.length).toBe(1);
    expect(assistants[0].id).toBe('message_test123');
  });

  test('INV-1: pre-existing orphan tool_use is remediated via synthesizeOrphans', async () => {
    // Plant a prior assistant message with an orphan tool_use (status=running,
    // no matching tool_result). loadProjectedMessages (renamed from
    // loadAndReconcileMessages, TER-707/CTX-016) must detect this
    // and synthesize an error tool_result via writePart before the LLM is
    // queried for the next step. Set NODE_ENV=production so the dev-only
    // assertion does not throw at the boundary.
    process.env.NODE_ENV = 'production';
    const llm = createSimpleMockAdapter([{ text: 'recovered', stopReason: 'end_turn' }]);
    const { driver, store } = makeDriver({ llmClient: llm });

    const orphanMsg: AssistantMessage = {
      id: 'message_prior',
      sessionID: 'sess_test',
      role: 'assistant',
      time: { created: Date.now() - 1000 },
      system: [],
      modelID: '',
      providerID: '',
      mode: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await store.writeMessage(orphanMsg);
    const orphanTool: ToolPart = {
      id: 'part_orphan',
      sessionID: 'sess_test',
      messageID: 'message_prior',
      type: 'tool',
      tool: 'echo',
      callID: 'call_orphan',
      state: { status: 'running', input: {}, time: { start: Date.now() - 500 } },
    } as ToolPart;
    await store.writePart(orphanTool);

    await driver.runTurn(makeInput(), { signal: new AbortController().signal });

    // synthesizeOrphans must have overwritten the orphan with an error
    // synthetic — same part id, status=error, meta.synthetic=true.
    const post = store.parts.get('part_orphan') as ToolPart;
    expect(post.state.status).toBe('error');
    expect((post as any).meta?.synthetic).toBe(true);
  });
});
