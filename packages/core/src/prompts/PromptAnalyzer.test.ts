/**
 * PromptAnalyzer tests (TER-469).
 *
 * Red del análisis de breakdown: serialización de tools, separación
 * user/assistant/toolCalls/toolResults, details exactos y quickEstimate.
 *
 * Nota de asimetría documentada: PromptAnalyzer cuenta `state.input` de
 * CUALQUIER status truthy (incl. pending), mientras que el estimador de
 * PromptBuilder solo cuenta completed/error/running. Ambos contratos se
 * fijan en sus tests respectivos.
 */

import { describe, expect, it } from 'bun:test';
import type { MessageWithParts } from '../session/types';
import { PromptAnalyzer, promptAnalyzer } from './PromptAnalyzer';

function mkMsg(role: 'user' | 'assistant', id: string, parts: any[]): MessageWithParts {
  return {
    info: { id, sessionID: 's', role, time: { created: 1 } } as any,
    parts,
  };
}

const text = (t: string) => ({ type: 'text', text: t });
const tool = (name: string, state: any) => ({
  type: 'tool',
  tool: name,
  callID: `call-${name}`,
  state,
});

describe('PromptAnalyzer.analyze', () => {
  it('empty components → all-zero breakdown, total 0, zeroed details (exact payload)', () => {
    const analyzer = new PromptAnalyzer();
    const result = analyzer.analyze({ systemPrompt: '' });

    expect(result).toEqual({
      breakdown: {
        system: 0,
        tools: 0,
        examples: 0,
        memory: 0,
        summary: 0,
        conversation: 0,
        toolCalls: 0,
        toolResults: 0,
        output: 0,
      },
      total: 0,
      details: {
        systemPromptLength: 0,
        toolCount: 0,
        toolDescriptionsLength: 0,
        examplesLength: 0,
        memoryContextLength: 0,
        summaryLength: 0,
        messageCount: 0,
        userMessagesLength: 0,
        assistantMessagesLength: 0,
        toolCallsLength: 0,
        toolResultsLength: 0,
      },
    });
  });

  it('counts each scalar component with the chars/4 (round) heuristic when provider is absent', () => {
    const analyzer = new PromptAnalyzer();
    // shared estimateTokens usa Math.round (no ceil): 6 chars → round(1.5) = 2
    const result = analyzer.analyze({
      systemPrompt: 'x'.repeat(40), // 10
      examples: 'e'.repeat(6), // round(1.5) = 2
      memoryContext: 'm'.repeat(16), // 4
      summary: 's'.repeat(2), // round(0.5) = 1 (round-half-up)
    });

    expect(result.breakdown.system).toBe(10);
    expect(result.breakdown.examples).toBe(2);
    expect(result.breakdown.memory).toBe(4);
    expect(result.breakdown.summary).toBe(1);
    expect(result.total).toBe(17);
  });

  it('serializes tools in the exact "Tool/Description/Parameters" format', () => {
    const analyzer = new PromptAnalyzer();
    const tools = [
      { name: 't1', description: 'first', input_schema: { type: 'object' } },
      { name: 't2', description: undefined, input_schema: undefined },
    ] as any;
    const result = analyzer.analyze({ systemPrompt: '', tools });

    const expectedSerialization =
      `Tool: t1\nDescription: first\nParameters: ${JSON.stringify({ type: 'object' }, null, 2)}` +
      '\n\n' +
      'Tool: t2\nDescription: \nParameters: ';
    expect(result.details.toolDescriptionsLength).toBe(expectedSerialization.length);
    expect(result.details.toolCount).toBe(2);
    expect(result.breakdown.tools).toBe(Math.round(expectedSerialization.length / 4));
  });

  it('splits conversation: user text → conversation, assistant text → output', () => {
    const analyzer = new PromptAnalyzer();
    const messages = [
      mkMsg('user', 'm1', [text('u'.repeat(7))]), // 'uuuuuuu\n' = 8 chars
      mkMsg('assistant', 'm2', [text('a'.repeat(11))]), // + '\n' = 12 chars
    ];
    const result = analyzer.analyze({ systemPrompt: '', messages });

    expect(result.breakdown.conversation).toBe(2); // round(8/4)
    expect(result.breakdown.output).toBe(3); // round(12/4)
    expect(result.details.userMessagesLength).toBe(8);
    expect(result.details.assistantMessagesLength).toBe(12);
    expect(result.details.messageCount).toBe(2);
  });

  it('tool inputs count as toolCalls in "name(json)" form; outputs as toolResults', () => {
    const analyzer = new PromptAnalyzer();
    const messages = [
      mkMsg('assistant', 'm1', [
        tool('search', {
          status: 'completed',
          input: { q: 'tea' },
          output: 'found it',
        }),
      ]),
    ];
    const result = analyzer.analyze({ systemPrompt: '', messages });

    // toolCalls: 'search({"q":"tea"})\n' = 20 chars → 5
    expect(result.details.toolCallsLength).toBe('search({"q":"tea"})\n'.length);
    expect(result.breakdown.toolCalls).toBe(5);
    // toolResults: 'found it\n' = 9 chars → round(2.25) = 2
    expect(result.details.toolResultsLength).toBe(9);
    expect(result.breakdown.toolResults).toBe(2);
  });

  it('error state output counts with the "Error: " prefix', () => {
    const analyzer = new PromptAnalyzer();
    const messages = [
      mkMsg('assistant', 'm1', [tool('runx', { status: 'error', input: {}, error: 'boom' })]),
    ];
    const result = analyzer.analyze({ systemPrompt: '', messages });

    // 'Error: boom\n' = 12 chars → 3
    expect(result.details.toolResultsLength).toBe(12);
    expect(result.breakdown.toolResults).toBe(3);
  });

  it('empty-object input ({}) still counts as a tool call (truthy guard)', () => {
    const analyzer = new PromptAnalyzer();
    const messages = [
      mkMsg('assistant', 'm1', [tool('noop', { status: 'running', input: {} })]),
    ];
    const result = analyzer.analyze({ systemPrompt: '', messages });
    expect(result.details.toolCallsLength).toBe('noop({})\n'.length);
  });

  it('completed with empty output and error with empty message contribute no toolResults', () => {
    const analyzer = new PromptAnalyzer();
    const messages = [
      mkMsg('assistant', 'm1', [tool('a', { status: 'completed', input: { x: 1 }, output: '' })]),
      mkMsg('assistant', 'm2', [tool('b', { status: 'error', input: { x: 1 }, error: '' })]),
    ];
    const result = analyzer.analyze({ systemPrompt: '', messages });
    expect(result.details.toolResultsLength).toBe(0);
    expect(result.breakdown.toolResults).toBe(0);
  });

  it('total is the sum of all 9 counted categories (exact arithmetic)', () => {
    const analyzer = new PromptAnalyzer();
    const result = analyzer.analyze({
      systemPrompt: 'x'.repeat(8), // 2
      examples: 'e'.repeat(4), // 1
      memoryContext: 'm'.repeat(4), // 1
      summary: 's'.repeat(4), // 1
      messages: [
        mkMsg('user', 'm1', [text('u'.repeat(3))]), // 4 chars → 1
        mkMsg('assistant', 'm2', [
          text('a'.repeat(3)), // 4 chars → 1
          tool('t', { status: 'completed', input: { a: 1 }, output: 'o'.repeat(7) }),
          // toolCalls: 't({"a":1})\n' = 11 → 3 · toolResults: 8 chars → 2
        ]),
      ],
    });

    expect(result.breakdown).toEqual({
      system: 2,
      tools: 0,
      examples: 1,
      memory: 1,
      summary: 1,
      conversation: 1,
      output: 1,
      toolCalls: 3,
      toolResults: 2,
    });
    expect(result.total).toBe(12);
  });

  it('with provider, uses the BPE tokenizer instead of chars/4', () => {
    const analyzer = new PromptAnalyzer();
    // 'x'.repeat(40): chars/4 → 10; claude BPE → 2 (verificado en token-counter)
    const result = analyzer.analyze({ systemPrompt: 'x'.repeat(40) }, 'anthropic');
    expect(result.breakdown.system).toBe(2);
  });
});

describe('PromptAnalyzer.quickEstimate', () => {
  it('returns the exact arithmetic breakdown with defaults', () => {
    const analyzer = new PromptAnalyzer();
    const estimate = analyzer.quickEstimate('x'.repeat(40), 3, 5);
    expect(estimate).toEqual({
      system: 10,
      tools: 600, // 3 × 200
      examples: 0,
      memory: 0,
      summary: 0,
      conversation: 2500, // 5 × 500
      toolCalls: 0,
      toolResults: 0,
      output: 0,
    });
  });

  it('honors custom averages', () => {
    const analyzer = new PromptAnalyzer();
    const estimate = analyzer.quickEstimate('', 2, 4, 100, 50);
    expect(estimate.tools).toBe(200);
    expect(estimate.conversation).toBe(200);
  });
});

describe('promptAnalyzer singleton', () => {
  it('is a PromptAnalyzer instance', () => {
    expect(promptAnalyzer).toBeInstanceOf(PromptAnalyzer);
  });
});
