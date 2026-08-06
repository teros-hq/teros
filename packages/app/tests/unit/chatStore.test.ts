/**
 * Tests for new chatStore actions added by the conversation turn redesign:
 *   1. `setAgentPhase('idle', channelId)` clears `isStreaming` on every
 *      agent message of the channel — turns ending on tool_call / abort
 *      never fire `text_complete`, so this is the safety net.
 *   2. `setAgentPhase(...)` writes `channels[id].agentPhase`.
 *   3. `reorderMessageToEnd` moves an id to the tail preserving relative
 *      order of the rest.
 *   4. `reorderMessageToEnd` is a silent no-op when the id is unknown.
 *
 * Strategy: hit the zustand store directly via `getState()` /
 * `setState()`. Reset the slice at the start of every test so the
 * registry-shared singleton doesn't leak between cases.
 */
import { describe, expect, it, beforeEach } from 'bun:test';

import { useChatStore } from '../../src/store/chatStore';
import type { Message } from '../../src/store/chatStore';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMessage(
  id: string,
  channelId: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    channelId,
    content: { type: 'text', text: id },
    sender: 'agent',
    timestamp: new Date(Date.now() + parseInt(id.replace(/\D/g, '') || '0', 10)),
    ...overrides,
  };
}

function seed(messages: Message[]) {
  const byId: Record<string, Message> = {};
  const byChannel: Record<string, string[]> = {};
  for (const m of messages) {
    byId[m.id] = m;
    (byChannel[m.channelId] ||= []).push(m.id);
  }
  useChatStore.setState({
    messages: byId,
    channels: {},
    channelMessages: byChannel,
  });
}

beforeEach(() => {
  useChatStore.getState().resetSession();
});

// ── setAgentPhase ───────────────────────────────────────────────────────────

describe('chatStore.setAgentPhase', () => {
  it('clears isStreaming on every agent message of the channel when phase=idle', () => {
    const ch = 'ch_1';
    seed([
      makeMessage('m1', ch, { sender: 'user', isStreaming: undefined }),
      makeMessage('m2', ch, { sender: 'agent', isStreaming: true }),
      makeMessage('m3', ch, { sender: 'agent', isStreaming: true }),
      makeMessage('m4', 'ch_2', { sender: 'agent', isStreaming: true }), // other channel
    ]);

    useChatStore.getState().setAgentPhase(ch, 'idle');

    const s = useChatStore.getState();
    expect(s.messages.m2.isStreaming).toBe(false);
    expect(s.messages.m3.isStreaming).toBe(false);
    // user message untouched
    expect(s.messages.m1.isStreaming).toBeUndefined();
    // other channel untouched
    expect(s.messages.m4.isStreaming).toBe(true);
  });

  it('does NOT clear isStreaming when phase != idle', () => {
    const ch = 'ch_1';
    seed([makeMessage('m1', ch, { sender: 'agent', isStreaming: true })]);

    useChatStore.getState().setAgentPhase(ch, 'streaming_text');

    expect(useChatStore.getState().messages.m1.isStreaming).toBe(true);
  });

  it('writes channels[id].agentPhase', () => {
    useChatStore.getState().setAgentPhase('ch_99', 'thinking');
    expect(useChatStore.getState().channels.ch_99?.agentPhase).toBe('thinking');

    useChatStore.getState().setAgentPhase('ch_99', 'executing_tool');
    expect(useChatStore.getState().channels.ch_99?.agentPhase).toBe('executing_tool');
  });
});

// ── reorderMessageToEnd ─────────────────────────────────────────────────────

describe('chatStore.reorderMessageToEnd', () => {
  it('moves messageId to the tail and preserves relative order of the rest', () => {
    const ch = 'ch_1';
    // All agent messages so the user/sent-timestamp guard in the insertion
    // loop trivially `break`s and we land at the literal tail.
    seed([
      makeMessage('m1', ch, { sender: 'agent' }),
      makeMessage('m2', ch, { sender: 'agent' }),
      makeMessage('m3', ch, { sender: 'agent' }),
      makeMessage('m4', ch, { sender: 'agent' }),
      makeMessage('m5', ch, { sender: 'agent' }),
    ]);

    useChatStore.getState().reorderMessageToEnd(ch, 'm2');

    const ids = useChatStore.getState().channelMessages[ch];
    expect(ids).toEqual(['m1', 'm3', 'm4', 'm5', 'm2']);
  });

  it('is a silent no-op when messageId is not in the channel', () => {
    const ch = 'ch_1';
    seed([
      makeMessage('m1', ch, { sender: 'agent' }),
      makeMessage('m2', ch, { sender: 'agent' }),
    ]);

    expect(() =>
      useChatStore.getState().reorderMessageToEnd(ch, 'does_not_exist'),
    ).not.toThrow();

    expect(useChatStore.getState().channelMessages[ch]).toEqual(['m1', 'm2']);
  });

  it('is a silent no-op when the channel itself has no message list', () => {
    expect(() =>
      useChatStore.getState().reorderMessageToEnd('unknown_channel', 'm1'),
    ).not.toThrow();
  });
});
