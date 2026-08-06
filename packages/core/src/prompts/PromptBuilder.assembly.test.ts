/**
 * PromptBuilder assembly tests (TER-469).
 *
 * Red directa del ensamblado de buildPrompt: pares sintéticos exactos
 * (summary/memory/context), split previous/latest, interacción del
 * breakpoint mod-N con los sintéticos del summary, breakdown de tokens
 * con payload exacto, y `totalFromBreakdown`.
 *
 * Complementa `PromptBuilder.test.ts` (estrategia mod-N del breakpoint)
 * e `inv1.test.ts` (detección INV-1). No duplica ninguno de los dos.
 */

import { describe, expect, it } from 'bun:test';
import type { MessageWithParts, TextPart, ToolPart } from '../session/types';
import { buildPrompt, PromptBuilder, totalFromBreakdown } from './PromptBuilder';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mkTextMsg(role: 'user' | 'assistant', id: string, text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'session_test',
      role,
      time: { created: 1_700_000_000_000 },
    } as any,
    parts: [
      {
        id: `${id}-part`,
        sessionID: 'session_test',
        messageID: id,
        type: 'text',
        text,
        time: { start: 1_700_000_000_000, end: 1_700_000_000_000 },
      } as any,
    ],
  };
}

function mkToolMsg(id: string, toolPart: Partial<ToolPart> & { state: any }): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'session_test',
      role: 'assistant',
      time: { created: 1_700_000_000_000 },
    } as any,
    parts: [
      {
        id: `${id}-part`,
        sessionID: 'session_test',
        messageID: id,
        type: 'tool',
        tool: 'test-tool',
        callID: `call-${id}`,
        ...toolPart,
      } as any,
    ],
  };
}

function mkMessages(count: number): MessageWithParts[] {
  return Array.from({ length: count }, (_, i) =>
    mkTextMsg(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, `Message ${i}`),
  );
}

function textOf(msg: MessageWithParts): string {
  return (msg.parts[0] as TextPart).text;
}

// ─────────────────────────────────────────────────────────────────────────────
// systemPrompt (bloques 1 + 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrompt — systemPrompt', () => {
  it('without examples, systemPrompt is exactly the system string', () => {
    const built = buildPrompt({ system: 'You are X.', messages: [] });
    expect(built.systemPrompt).toBe('You are X.');
  });

  it('with examples, appends the exact "## Examples" section', () => {
    const built = buildPrompt({
      system: 'You are X.',
      examples: 'Q: hi\nA: hello',
      messages: [],
    });
    expect(built.systemPrompt).toBe('You are X.\n\n## Examples\n\n' + 'Q: hi\nA: hello');
  });

  it('empty-string examples is falsy → no Examples section appended', () => {
    const built = buildPrompt({ system: 'S', examples: '', messages: [] });
    expect(built.systemPrompt).toBe('S');
  });

  it('tools pass through untouched (same reference)', () => {
    const tools = [{ name: 't1', description: 'd', input_schema: { type: 'object' } }] as any;
    const built = buildPrompt({ system: 'S', tools, messages: [] });
    expect(built.tools).toBe(tools);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pares sintéticos (bloques 4, 6, 7)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrompt — synthetic pairs', () => {
  it('summary injects a user+assistant pair with exact texts at the head', () => {
    const built = buildPrompt({ system: 'S', summary: 'we talked about apples', messages: [] });

    expect(built.messages.length).toBe(2);
    const [summaryMsg, ackMsg] = built.messages;

    expect(summaryMsg.info.role).toBe('user');
    expect(textOf(summaryMsg)).toBe('[Previous Conversation Summary]\n\nwe talked about apples');
    expect((summaryMsg.parts[0] as any).synthetic).toBe(true);
    expect(summaryMsg.info.sessionID).toBe('synthetic');

    expect(ackMsg.info.role).toBe('assistant');
    expect(textOf(ackMsg)).toBe(
      "I understand the context from the previous conversation. I'll continue from here.",
    );
    expect((ackMsg.parts[0] as any).synthetic).toBe(true);
  });

  it('memory injects a user+assistant pair with exact texts after the breakpoint', () => {
    const built = buildPrompt({ system: 'S', memory: 'user likes tea', messages: [] });

    expect(built.messages.length).toBe(2);
    const [memMsg, ackMsg] = built.messages;
    expect(memMsg.info.role).toBe('user');
    expect(textOf(memMsg)).toBe('[Relevant Memory]\n\nuser likes tea');
    expect(ackMsg.info.role).toBe('assistant');
    expect(textOf(ackMsg)).toBe("I'll take this context into account.");
  });

  it('context block renders channelId/thread/timestamp/environment in exact order', () => {
    const built = buildPrompt(
      {
        system: 'S',
        messages: [],
        context: {
          channelId: 'ch_1234',
          threadId: 7,
          timestamp: 1_700_000_000_000,
          environment: { REGION: 'eu', MODE: 'dev' },
        },
      },
      { includeTimestamp: true },
    );

    const [ctxMsg, ackMsg] = built.messages;
    expect(textOf(ctxMsg)).toBe(
      '[Current Context]\n\n' +
        'Channel: ch_1234\n' +
        'Thread: 7\n' +
        `Current time: ${new Date(1_700_000_000_000).toISOString()}\n` +
        'REGION: eu\n' +
        'MODE: dev',
    );
    expect(textOf(ackMsg)).toBe('Understood.');
  });

  it('includeTimestamp=false omits the Current time line', () => {
    const built = buildPrompt(
      { system: 'S', messages: [], context: { channelId: 'ch_1' } },
      { includeTimestamp: false },
    );
    expect(textOf(built.messages[0])).toBe('[Current Context]\n\nChannel: ch_1');
  });

  it('threadId=0 is omitted (falsy guard — documented current behavior)', () => {
    const built = buildPrompt(
      { system: 'S', messages: [], context: { channelId: 'ch_1', threadId: 0 } },
      { includeTimestamp: false },
    );
    expect(textOf(built.messages[0])).toBe('[Current Context]\n\nChannel: ch_1');
  });

  it('no summary/memory/context → zero synthetic messages', () => {
    const built = buildPrompt({ system: 'S', messages: mkMessages(3) });
    expect(built.metadata.messageCounts.synthetic).toBe(0);
    expect(built.messages.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orden de bloques y split previous/latest
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrompt — block order and split', () => {
  it('assembles blocks in exact order: summary pair → previous → memory pair → context pair → latest', () => {
    const built = buildPrompt(
      {
        system: 'S',
        summary: 'sum',
        memory: 'mem',
        context: { channelId: 'ch_1' },
        messages: mkMessages(25),
      },
      { latestMessageCount: 20, cacheBlockSize: 20, includeTimestamp: false },
    );

    // 2 (summary) + 5 (previous) + 2 (memory) + 2 (context) + 20 (latest) = 31
    expect(built.messages.length).toBe(31);
    expect(built.metadata.messageCounts).toEqual({
      synthetic: 6,
      previous: 5,
      latest: 20,
      total: 31,
    });

    expect(textOf(built.messages[0])).toBe('[Previous Conversation Summary]\n\nsum');
    expect(built.messages[1].info.role).toBe('assistant'); // summary ack
    // previous = msg-0..msg-4
    expect(built.messages.slice(2, 7).map((m) => m.info.id)).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
    ]);
    expect(textOf(built.messages[7])).toBe('[Relevant Memory]\n\nmem');
    expect(textOf(built.messages[9])).toBe('[Current Context]\n\nChannel: ch_1');
    expect(textOf(built.messages[10])).toBe('Understood.');
    // latest = msg-5..msg-24
    expect(built.messages.slice(11).map((m) => m.info.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `msg-${i + 5}`),
    );
  });

  it('fewer messages than latestMessageCount → everything is latest, previous empty', () => {
    const built = buildPrompt({ system: 'S', messages: mkMessages(5) }, { latestMessageCount: 20 });
    expect(built.metadata.messageCounts).toEqual({
      synthetic: 0,
      previous: 0,
      latest: 5,
      total: 5,
    });
    expect(built.messages.map((m) => m.info.id)).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
    ]);
  });

  it('exactly latestMessageCount messages → previous empty', () => {
    const built = buildPrompt({ system: 'S', messages: mkMessages(20) }, { latestMessageCount: 20 });
    expect(built.metadata.messageCounts.previous).toBe(0);
    expect(built.metadata.messageCounts.latest).toBe(20);
  });

  it('count > latestCount/2 but < latestCount → still everything latest (negative-split guard)', () => {
    // Caza la mutación que elimina Math.max(0, …) del splitIndex: con 15
    // msgs y latestCount=20, slice(0, -5) daría previous = 10 primeros.
    const built = buildPrompt(
      { system: 'S', messages: mkMessages(15) },
      { latestMessageCount: 20 },
    );
    expect(built.metadata.messageCounts).toEqual({
      synthetic: 0,
      previous: 0,
      latest: 15,
      total: 15,
    });
    expect(built.messages.map((m) => m.info.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => `msg-${i}`),
    );
  });

  it('original message objects pass through by reference (no cloning)', () => {
    const msgs = mkMessages(3);
    const built = buildPrompt({ system: 'S', messages: msgs });
    expect(built.messages[0]).toBe(msgs[0]);
    expect(built.messages[2]).toBe(msgs[2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Breakpoint × sintéticos del summary
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrompt — breakpoint interaction with summary synthetics', () => {
  it('summary pair shifts the snapped breakpoint index by 2', () => {
    // 45 msgs, latest=20 → previous=25, snapped=20.
    // Without summary: syntheticBeforePrevious=0 → index 19.
    // With summary:    syntheticBeforePrevious=2 → index 21.
    const base = {
      system: 'S',
      messages: mkMessages(45),
    };
    const cfg = { latestMessageCount: 20, cacheBlockSize: 20 };

    const without = buildPrompt(base, cfg);
    expect(without.metadata.cacheBreakpointIndex).toBe(19);
    expect(without.messages[19].info.id).toBe('msg-19');

    const withSummary = buildPrompt({ ...base, summary: 'sum' }, cfg);
    expect(withSummary.metadata.cacheBreakpointIndex).toBe(21);
    // The breakpoint still lands on the same conversation message.
    expect(withSummary.messages[21].info.id).toBe('msg-19');
  });

  it('memory/context pairs (after the breakpoint) do NOT shift the index', () => {
    const cfg = { latestMessageCount: 20, cacheBlockSize: 20 };
    const without = buildPrompt({ system: 'S', messages: mkMessages(45) }, cfg);
    const withDynamic = buildPrompt(
      {
        system: 'S',
        memory: 'mem',
        context: { channelId: 'ch_1' },
        messages: mkMessages(45),
      },
      cfg,
    );
    expect(withDynamic.metadata.cacheBreakpointIndex).toBe(without.metadata.cacheBreakpointIndex);
  });

  it('with zero messages, metadata reports legacy mode (blockSize 0, breakpoint -1)', () => {
    // blockSize>0 requires previousMessages.length>0; empty history falls
    // through to the legacy branch — documented current behavior.
    const built = buildPrompt({ system: 'S', messages: [] }, { cacheBlockSize: 20 });
    expect(built.metadata.cacheBreakpointIndex).toBe(-1);
    expect(built.metadata.cacheBlockSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token breakdown (heurística chars/4, sin provider)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrompt — token breakdown (exact payloads, chars/4 heuristic)', () => {
  it('computes the full breakdown exactly for known component sizes', () => {
    // system: 40 chars → 10 · examples: 20 → 5 · summary: 12 → 3 · memory: 16 → 4
    // context: JSON {"channelId":"ch_12345678"} = 27 chars → 7
    // tools: undefined → "[]" → 1
    // 2 latest text msgs de 40 chars → (10 + 10 overhead) × 2 = 40
    const built = buildPrompt(
      {
        system: 'x'.repeat(40),
        examples: 'e'.repeat(20),
        summary: 's'.repeat(12),
        memory: 'm'.repeat(16),
        context: { channelId: 'ch_12345678' },
        messages: [mkTextMsg('user', 'm1', 'u'.repeat(40)), mkTextMsg('assistant', 'm2', 'a'.repeat(40))],
      },
      { includeTimestamp: false },
    );

    expect(built.breakdown).toEqual({
      system: 10,
      tools: 1,
      examples: 5,
      summary: 3,
      previous: 0,
      memory: 4,
      context: 7,
      latest: 40,
      output: 0,
      conversation: 40,
      toolCalls: 0,
      toolResults: 0,
    });
  });

  it('splits conversation tokens between previous and latest at the split index', () => {
    // 3 msgs de 40 chars, latest=2 → previous = msg-0 (20), latest = msg-1+msg-2 (40)
    const msgs = [
      mkTextMsg('user', 'msg-0', 'u'.repeat(40)),
      mkTextMsg('assistant', 'msg-1', 'a'.repeat(40)),
      mkTextMsg('user', 'msg-2', 'u'.repeat(40)),
    ];
    const built = buildPrompt({ system: 'S', messages: msgs }, { latestMessageCount: 2 });

    expect(built.breakdown.previous).toBe(20);
    expect(built.breakdown.latest).toBe(40);
    expect(built.breakdown.conversation).toBe(60);
  });

  it('completed tool part: input counts as toolCalls, output as toolResults, both in total', () => {
    // input {"a":1} → 7 chars → 2 · output "ok!!" → 4 chars → 1 · overhead 10 → total 13
    const msg = mkToolMsg('msg-t', {
      state: {
        status: 'completed',
        input: { a: 1 },
        output: 'ok!!',
        title: '',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    const built = buildPrompt({ system: '', messages: [msg] });

    expect(built.breakdown.toolCalls).toBe(2);
    expect(built.breakdown.toolResults).toBe(1);
    expect(built.breakdown.latest).toBe(13);
  });

  it('error tool part: input counts as toolCalls, error message as toolResults', () => {
    // input {} → 2 chars → 1 · error 8 chars → 2 · overhead 10 → total 13
    const msg = mkToolMsg('msg-t', {
      state: { status: 'error', input: {}, error: 'e'.repeat(8), time: { start: 1, end: 2 } },
    });
    const built = buildPrompt({ system: '', messages: [msg] });

    expect(built.breakdown.toolCalls).toBe(1);
    expect(built.breakdown.toolResults).toBe(2);
    expect(built.breakdown.latest).toBe(13);
  });

  it('running tool part: only input counts (no output yet)', () => {
    const msg = mkToolMsg('msg-t', {
      state: { status: 'running', input: { q: 'zz' }, time: { start: 1 } },
    });
    const built = buildPrompt({ system: '', messages: [msg] });

    // {"q":"zz"} → 10 chars → 3
    expect(built.breakdown.toolCalls).toBe(3);
    expect(built.breakdown.toolResults).toBe(0);
    expect(built.breakdown.latest).toBe(13);
  });

  it('pending/pending_approval tool parts contribute zero (documented estimator gap)', () => {
    const pending = mkToolMsg('msg-p', { state: { status: 'pending', input: { a: 1 } } });
    const approval = mkToolMsg('msg-pa', {
      state: { status: 'pending_approval', input: { a: 1 }, time: { start: 1 } },
    });
    const built = buildPrompt({ system: '', messages: [pending, approval] });

    expect(built.breakdown.toolCalls).toBe(0);
    expect(built.breakdown.toolResults).toBe(0);
    // Only the 10-token structural overhead per message.
    expect(built.breakdown.latest).toBe(20);
  });

  it('breakdown.output is always 0 at build time (filled after LLM response)', () => {
    const built = buildPrompt({ system: 'S', messages: mkMessages(3) });
    expect(built.breakdown.output).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// totalFromBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe('totalFromBreakdown', () => {
  it('sums the 9 schema categories and EXCLUDES conversation/toolCalls/toolResults', () => {
    const total = totalFromBreakdown({
      system: 10,
      tools: 1,
      examples: 5,
      summary: 3,
      previous: 20,
      memory: 4,
      context: 7,
      latest: 40,
      output: 6,
      // Estos tres NO deben sumar (conversation duplica previous+latest;
      // toolCalls/toolResults son subconjuntos de conversation):
      conversation: 60,
      toolCalls: 11,
      toolResults: 13,
    });
    expect(total).toBe(10 + 1 + 5 + 3 + 20 + 4 + 7 + 40 + 6); // = 96
  });

  it('treats optional fields (previous/context/latest/output) as 0 when undefined', () => {
    const total = totalFromBreakdown({
      system: 2,
      tools: 3,
      examples: 0,
      summary: 0,
      memory: 1,
      conversation: 99,
    } as any);
    expect(total).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens (export del namespace PromptBuilder)
// ─────────────────────────────────────────────────────────────────────────────

describe('PromptBuilder.estimateTokens', () => {
  it('empty/undefined-ish text → 0', () => {
    expect(PromptBuilder.estimateTokens('')).toBe(0);
  });

  it('without provider uses ceil(chars/4)', () => {
    expect(PromptBuilder.estimateTokens('abcd')).toBe(1); // 4/4
    expect(PromptBuilder.estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(PromptBuilder.estimateTokens('x'.repeat(40))).toBe(10);
  });

  it('with provider uses the BPE tokenizer (claude: "hello world" → 2)', () => {
    // Valor verificado contra ai-tokenizer 1.x (encoding claude).
    expect(PromptBuilder.estimateTokens('hello world', 'anthropic')).toBe(2);
    // BPE comprime repeticiones: 40 x's son 2 tokens, no 10.
    expect(PromptBuilder.estimateTokens('x'.repeat(40), 'anthropic')).toBe(2);
  });
});
