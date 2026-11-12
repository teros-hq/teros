import { describe, expect, it } from 'bun:test';
import {
  type EvalInput,
  type EvalMessage,
  type EvalToolCall,
  extractConversationMetrics,
  stableStringify,
} from './l1-extractor';

let seq = 0;
function call(
  tool: string,
  input: unknown,
  status: 'completed' | 'error' = 'completed',
  opts: Partial<EvalToolCall> = {},
): EvalToolCall {
  seq++;
  return {
    callId: `call_${seq}`,
    tool,
    input,
    inputKey: stableStringify(input),
    status,
    startedAt: seq * 1000,
    endedAt: seq * 1000 + 10,
    ...opts,
  };
}

function msg(role: 'user' | 'assistant', text: string, toolCalls: EvalToolCall[] = [], isVoice = false): EvalMessage {
  seq++;
  return { role, createdAt: seq * 1000, text, isVoice, toolCalls };
}

function input(messages: EvalMessage[], llmUsage: EvalInput['llmUsage'] = []): EvalInput {
  return { channelId: 'ch_test', messages, llmUsage };
}

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('REP-1', () => {
  it('fires on >=3 consecutive identical calls, no user message between', () => {
    const c = () => call('execute-tool', { taskId: 'x' }, 'completed', { app: 'board-manager', innerTool: 'boards_get-my-task' });
    const m = msg('assistant', '', [c(), c(), c()]);
    const out = extractConversationMetrics(input([m]));
    const rep1 = out.failures.filter((f) => f.code === 'REP-1');
    expect(rep1.length).toBe(1);
    expect(rep1[0].evidence.callIds?.length).toBe(3);
  });

  it('does NOT fire when a user message breaks the run', () => {
    const c = () => call('execute-tool', { taskId: 'x' }, 'completed', { app: 'board-manager', innerTool: 'boards_get-my-task' });
    const m1 = msg('assistant', '', [c(), c()]);
    const u = msg('user', 'espera');
    const m2 = msg('assistant', '', [c()]);
    const out = extractConversationMetrics(input([m1, u, m2]));
    expect(out.failures.filter((f) => f.code === 'REP-1').length).toBe(0);
  });

  it('does NOT fire on 2 identical calls', () => {
    const c = () => call('bash', { cmd: 'ls' });
    const out = extractConversationMetrics(input([msg('assistant', '', [c(), c()])]));
    expect(out.failures.filter((f) => f.code === 'REP-1').length).toBe(0);
  });
});

describe('REP-3', () => {
  it('fires when the same substantive assistant text is sent twice', () => {
    const t = 'Este es un informe largo y sustantivo con suficiente contenido para superar el umbral de ochenta caracteres sin problema alguno.';
    const out = extractConversationMetrics(input([msg('assistant', t), msg('user', 'ok'), msg('assistant', t)]));
    expect(out.failures.filter((f) => f.code === 'REP-3').length).toBe(1);
  });

  it('ignores short acks', () => {
    const out = extractConversationMetrics(input([msg('assistant', 'Vale.'), msg('user', 'sigue'), msg('assistant', 'Vale.')]));
    expect(out.failures.filter((f) => f.code === 'REP-3').length).toBe(0);
  });
});

describe('RTX-1', () => {
  it('fires on identical retry after error', () => {
    const bad = call('execute-tool', { taskId: 'x' }, 'error', { app: 'a', innerTool: 't' });
    const retry = call('execute-tool', { taskId: 'x' }, 'completed', { app: 'a', innerTool: 't' });
    const out = extractConversationMetrics(input([msg('assistant', '', [bad, retry])]));
    expect(out.failures.filter((f) => f.code === 'RTX-1').length).toBe(1);
  });

  it('does not fire when the retry changes input', () => {
    const bad = call('execute-tool', { taskId: 'x' }, 'error', { app: 'a', innerTool: 't' });
    const retry = call('execute-tool', { taskId: 'y' }, 'completed', { app: 'a', innerTool: 't' });
    const out = extractConversationMetrics(input([msg('assistant', '', [bad, retry])]));
    expect(out.failures.filter((f) => f.code === 'RTX-1').length).toBe(0);
  });
});

describe('RTX-2', () => {
  it('fires on error -> params changed -> error without schema consultation', () => {
    const e1 = call('execute-tool', { path: '/a' }, 'error', { app: 'fs', innerTool: 'read' });
    const e2 = call('execute-tool', { filePath: '/a' }, 'error', { app: 'fs', innerTool: 'read' });
    const out = extractConversationMetrics(input([msg('assistant', '', [e1, e2])]));
    expect(out.failures.filter((f) => f.code === 'RTX-2').length).toBe(1);
  });

  it('does NOT fire when list-app-tools is consulted between errors', () => {
    const e1 = call('execute-tool', { path: '/a' }, 'error', { app: 'fs', innerTool: 'read' });
    const consult = call('list-app-tools', { app: 'fs' });
    const e2 = call('execute-tool', { filePath: '/a' }, 'error', { app: 'fs', innerTool: 'read' });
    const out = extractConversationMetrics(input([msg('assistant', '', [e1, consult, e2])]));
    expect(out.failures.filter((f) => f.code === 'RTX-2').length).toBe(0);
  });
});

describe('INE-1', () => {
  it('fires on >=10 consecutive pagination calls when search/filter exists on the tool', () => {
    const pages: EvalToolCall[] = [];
    for (let p = 1; p <= 12; p++) pages.push(call('execute-tool', { page: p, limit: 20 }, 'completed', { app: 'wa', innerTool: 'get-chats' }));
    // a separate call proves the tool accepts a search/filter param
    const searched = call('execute-tool', { query: 'instinct' }, 'completed', { app: 'wa', innerTool: 'get-chats' });
    const out = extractConversationMetrics(input([msg('assistant', '', [...pages, searched])]));
    expect(out.failures.filter((f) => f.code === 'INE-1').length).toBe(1);
  });

  it('does NOT fire on <10 pages', () => {
    const pages: EvalToolCall[] = [];
    for (let p = 1; p <= 5; p++) pages.push(call('execute-tool', { page: p }, 'completed', { app: 'wa', innerTool: 'get-chats' }));
    const searched = call('execute-tool', { query: 'x' }, 'completed', { app: 'wa', innerTool: 'get-chats' });
    const out = extractConversationMetrics(input([msg('assistant', '', [...pages, searched])]));
    expect(out.failures.filter((f) => f.code === 'INE-1').length).toBe(0);
  });
});

describe('INE-2', () => {
  it('fires on >=8 one-by-one calls when a bulk/filter alternative exists', () => {
    const probes: EvalToolCall[] = [];
    for (let i = 1; i <= 10; i++) probes.push(call('execute-tool', { chatId: `id_${i}` }, 'completed', { app: 'wa', innerTool: 'get-messages' }));
    const filtered = call('execute-tool', { query: 'x' }, 'completed', { app: 'wa', innerTool: 'get-messages' });
    const out = extractConversationMetrics(input([msg('assistant', '', [...probes, filtered])]));
    expect(out.failures.filter((f) => f.code === 'INE-2').length).toBe(1);
  });
});

describe('INE-3', () => {
  it('fires when the same tool+input succeeds twice', () => {
    const a = call('execute-tool', { taskId: 'x' }, 'completed', { app: 'b', innerTool: 'get-task' });
    const b = call('execute-tool', { taskId: 'x' }, 'completed', { app: 'b', innerTool: 'get-task' });
    const out = extractConversationMetrics(input([msg('assistant', '', [a, b])]));
    expect(out.failures.filter((f) => f.code === 'INE-3').length).toBe(1);
  });

  it('does not fire when the first call errored', () => {
    const a = call('execute-tool', { taskId: 'x' }, 'error', { app: 'b', innerTool: 'get-task' });
    const b = call('execute-tool', { taskId: 'x' }, 'completed', { app: 'b', innerTool: 'get-task' });
    const out = extractConversationMetrics(input([msg('assistant', '', [a, b])]));
    expect(out.failures.filter((f) => f.code === 'INE-3').length).toBe(0);
  });
});

describe('metrics', () => {
  it('counts messages, tools, tokens, cost, stopReasons', () => {
    const calls = [call('bash', { cmd: 'ls' }), call('bash', { cmd: 'pwd' }, 'error')];
    const messages = [
      msg('user', 'hola', [], true),
      msg('assistant', 'trabajando', calls),
      msg('user', 'gracias'),
    ];
    const out = extractConversationMetrics(
      input(messages, [
        { modelId: 'm1', messageId: 'msg_1', timestamp: 1000, promptTokens: 10, completionTokens: 5, totalTokens: 15, costTotal: 0.01, stopReason: 'stop' },
        { modelId: 'm1', messageId: 'msg_2', timestamp: 5000, promptTokens: 20, completionTokens: 10, totalTokens: 30, costTotal: 0.02, stopReason: 'error' },
      ]),
    );
    expect(out.userMessages).toBe(2);
    expect(out.assistantMessages).toBe(1);
    expect(out.voiceMessages).toBe(1);
    expect(out.toolCallsTotal).toBe(2);
    expect(out.toolCallsError).toBe(1);
    expect(out.toolErrorRate).toBe(0.5);
    expect(out.steps).toBe(2);
    expect(out.costTotal).toBeCloseTo(0.03);
    expect(out.totalTokens).toBe(45);
    expect(out.stopReasons).toEqual({ stop: 1, error: 1 });
    expect(out.durationMs).toBe(4000);
  });
});
