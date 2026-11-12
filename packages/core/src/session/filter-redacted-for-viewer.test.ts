/**
 * MUW-F1: Redaction in LLM context — filterRedactedForViewer tests
 *
 * Tests that getMessagesForLLM filters redacted messages for non-owners,
 * while owners and internal callers (no viewerId) receive full context.
 *
 * Spec: REQ-5, NFR-2 — multi-user-workspaces.md
 */

import { describe, expect, it } from 'bun:test';
import { filterRedactedForViewer } from './SessionStore';
import type { MessageWithParts, TextPart, ToolPart, UserMessage, AssistantMessage } from './types';

const SECRET_TEXT = 'My credit card number is 4532-1234-5678-9012';
const SECRET_TOOL_INPUT = '{"query":"password=secret123"}';
const SECRET_TOOL_OUTPUT = '{"result":"password=secret123"}';

function makeTextPart(msgId: string, text: string, sessionId = 'ch_test'): TextPart {
  return {
    id: `part_${msgId}_text`,
    sessionID: sessionId,
    messageID: msgId,
    type: 'text',
    text,
    time: { start: Date.now() },
  };
}

function makeToolPart(msgId: string, input: string, output: string, sessionId = 'ch_test'): ToolPart {
  return {
    id: `part_${msgId}_tool`,
    sessionID: sessionId,
    messageID: msgId,
    type: 'tool',
    tool: 'gmail.search',
    state: { status: 'completed', result: output },
    input: { raw: input },
    time: { start: Date.now(), end: Date.now() },
  } as any;
}

function makeUserMessage(id: string, redacted = false): UserMessage {
  return {
    id,
    sessionID: 'ch_test',
    role: 'user',
    time: { created: Date.now() },
    redacted,
  };
}

function makeAssistantMessage(id: string, redacted = false): AssistantMessage {
  return {
    id,
    sessionID: 'ch_test',
    role: 'assistant',
    time: { created: Date.now() },
    system: [],
    modelID: 'test-model',
    providerID: 'test',
    mode: 'build',
    path: { cwd: '/tmp', root: '/tmp' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    redacted,
  };
}

function makeMessageWithParts(
  info: UserMessage | AssistantMessage,
  parts: TextPart[] | ToolPart[],
): MessageWithParts {
  return { info, parts } as any;
}

const OWNER_ID = 'user_owner';
const NON_OWNER_ID = 'user_non_owner';

describe('MUW-F1: filterRedactedForViewer — LLM context redaction', () => {
  describe('non-owner: redacted content is filtered from LLM context', () => {
    it('replaces redacted user message parts with placeholder', () => {
      const msg = makeMessageWithParts(
        makeUserMessage('msg_1', true),
        [makeTextPart('msg_1', SECRET_TEXT)],
      );

      const result = filterRedactedForViewer([msg], OWNER_ID, NON_OWNER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].info.redacted).toBe(true);
      expect(result[0].parts).toHaveLength(1);
      expect(result[0].parts[0].type).toBe('text');
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe('[Content redacted by the channel owner]');
      expect(textPart.synthetic).toBe(true);
    });

    it('replaces redacted assistant message parts (including tool parts) with placeholder', () => {
      const msg = makeMessageWithParts(
        makeAssistantMessage('msg_2', true),
        [
          makeTextPart('msg_2', SECRET_TEXT),
              makeToolPart('msg_2', SECRET_TOOL_INPUT, SECRET_TOOL_OUTPUT),
        ] as any,
      );

      const result = filterRedactedForViewer([msg], OWNER_ID, NON_OWNER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(1);
      expect(result[0].parts[0].type).toBe('text');
    });

    it('JSON audit: serialized non-owner payload does not contain secret content', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
        makeMessageWithParts(
          makeAssistantMessage('msg_2', true),
          [
            makeTextPart('msg_2', SECRET_TEXT),
                makeToolPart('msg_2', SECRET_TOOL_INPUT, SECRET_TOOL_OUTPUT),
          ] as any,
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, NON_OWNER_ID);

      // Audit the FULL serialized payload — no original content in any form
      const json = JSON.stringify(result);
      expect(json).not.toContain(SECRET_TEXT);
      expect(json).not.toContain(SECRET_TOOL_INPUT);
      expect(json).not.toContain(SECRET_TOOL_OUTPUT);
      expect(json).not.toContain('4532-1234-5678-9012');
      expect(json).not.toContain('password=secret123');

      // The placeholder IS present
      expect(json).toContain('[Content redacted by the channel owner]');
    });

    it('non-redacted messages pass through unchanged for non-owners', () => {
      const visibleText = 'This is public content';
      const msg = makeMessageWithParts(
        makeUserMessage('msg_1', false),
        [makeTextPart('msg_1', visibleText)],
      );

      const result = filterRedactedForViewer([msg], OWNER_ID, NON_OWNER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(1);
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe(visibleText);
    });

    it('mixed redacted and non-redacted messages: only redacted are filtered', () => {
      const publicText = 'Public discussion';
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', false),
          [makeTextPart('msg_1', publicText)],
        ),
        makeMessageWithParts(
          makeUserMessage('msg_2', true),
          [makeTextPart('msg_2', SECRET_TEXT)],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, NON_OWNER_ID);

      expect(result).toHaveLength(2);
      // First message unchanged
      expect((result[0].parts[0] as TextPart).text).toBe(publicText);
      // Second message replaced
      expect((result[1].parts[0] as TextPart).text).toBe('[Content redacted by the channel owner]');
    });
  });

  describe('owner: full context preserved', () => {
    it('owner sees full content of redacted messages', () => {
      const msg = makeMessageWithParts(
        makeUserMessage('msg_1', true),
        [makeTextPart('msg_1', SECRET_TEXT)],
      );

      const result = filterRedactedForViewer([msg], OWNER_ID, OWNER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(1);
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe(SECRET_TEXT);
    });

    it('JSON audit: owner payload contains the secret content', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID);
      const json = JSON.stringify(result);

      expect(json).toContain(SECRET_TEXT);
      expect(json).not.toContain('[Content redacted by the channel owner]');
    });
  });

  describe('internal callers (no viewerId): full context preserved', () => {
    it('omitting viewerId returns all messages unfiltered', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, undefined);

      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(1);
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe(SECRET_TEXT);
    });

    it('simulates TurnReconciler / appendInterruptionNote path (no viewerId)', () => {
      // These internal callers call getMessagesForLLM(sessionId) without
      // viewerId — they must receive the full context for crash recovery
      // and interruption note synthesis.
      const messages = [
        makeMessageWithParts(
          makeAssistantMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT), makeToolPart('msg_1', SECRET_TOOL_INPUT, SECRET_TOOL_OUTPUT)] as any,
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, undefined);

      // Tool parts preserved — needed for INV-1 reconciliation
      expect(result[0].parts.length).toBeGreaterThan(1);
      const json = JSON.stringify(result);
      expect(json).toContain(SECRET_TEXT);
      // Tool input is nested in input.raw, so check for the unescaped core value
      expect(json).toContain('password=secret123');
    });
  });

  describe('edge cases', () => {
    it('empty messages array returns empty', () => {
      const result = filterRedactedForViewer([], OWNER_ID, NON_OWNER_ID);
      expect(result).toEqual([]);
    });

    it('undefined ownerId with non-owner viewerId still filters (defensive)', () => {
      // If session doesn't exist or has no userId, treat viewer as non-owner
      const msg = makeMessageWithParts(
        makeUserMessage('msg_1', true),
        [makeTextPart('msg_1', SECRET_TEXT)],
      );

      const result = filterRedactedForViewer([msg], undefined, NON_OWNER_ID);

      expect(result[0].parts).toHaveLength(1);
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe('[Content redacted by the channel owner]');
    });

    it('placeholder part has correct metadata', () => {
      const msg = makeMessageWithParts(
        makeUserMessage('msg_1', true),
        [makeTextPart('msg_1', SECRET_TEXT)],
      );

      const result = filterRedactedForViewer([msg], OWNER_ID, NON_OWNER_ID);
      const part = result[0].parts[0] as TextPart;

      expect(part.id).toBe('redacted_msg_1');
      expect(part.sessionID).toBe('ch_test');
      expect(part.messageID).toBe('msg_1');
      expect(part.metadata?.redactedPlaceholder).toBe(true);
    });
  });

  // ── Agent-viewer mode (GAP 1 fix) ─────────────────────────────────────────
  // docs/specs/20261031_agent-secret-tools.md, design D.
  //
  // The LLM context build passes the channel OWNER's userId as viewerId, so
  // "viewer == owner" is exactly the agent's view. With viewerKind 'agent',
  // redacted messages are masked EVEN for the owner — the agent never gets
  // redacted plaintext; it sees `[redacted: <mask>]` placeholders.
  describe('agent-viewer mode (GAP 1): the agent never sees redacted plaintext', () => {
    it('masks redacted messages even when viewerId === ownerId (the LLM context build)', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
      ];

      // Same ids as the owner path — only viewerKind differs.
      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID, {
        viewerKind: 'agent',
      });

      expect(result).toHaveLength(1);
      expect(result[0].info.redacted).toBe(true);
      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.synthetic).toBe(true);
      // Text part has no secret-ish key → generic '[redacted]' placeholder
      expect(textPart.text).toBe('[redacted]');
      expect(textPart.text).not.toContain('4532');
    });

    it('derives the mask from tool part state.input (the …4f2a reference)', () => {
      const messages = [
        makeMessageWithParts(
          makeAssistantMessage('msg_2', true),
          [
            makeTextPart('msg_2', 'running the deploy'),
            makeToolPart('msg_2', SECRET_TOOL_INPUT, SECRET_TOOL_OUTPUT),
          ] as any,
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID, {
        viewerKind: 'agent',
      });

      const textPart = result[0].parts[0] as TextPart;
      // Tool input is { raw: '{"query":"password=secret123"}' } — the
      // secret-ish key scan finds nothing, but the catch-all stringifies the
      // raw input... the placeholder must still never leak the value.
      expect(textPart.text).not.toContain('secret123');
      expect(textPart.text).toMatch(/^\[redacted(: .*)?\]$/);
    });

    it('shows the mask when the tool input carries a secret-ish key', () => {
      const toolPart = {
        id: 'part_msg_3_tool',
        sessionID: 'ch_test',
        messageID: 'msg_3',
        type: 'tool',
        tool: 'remote.ssh',
        callID: 'call_1',
        state: {
          status: 'completed',
          input: { command: 'cat key.txt', apiKey: 'sk_live_51AbCdEfGhIjKlMn4f2a' },
          output: 'sk_live_51AbCdEfGhIjKlMn4f2a',
          title: '',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      } as any;

      const messages = [
        makeMessageWithParts(makeAssistantMessage('msg_3', true), [toolPart]),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID, {
        viewerKind: 'agent',
      });

      const textPart = result[0].parts[0] as TextPart;
      // Same mask format as get-app-secret — the agent can reference
      // "the …4f2a key" across both surfaces.
      expect(textPart.text).toBe('[redacted: sk_live_…4f2a]');
      expect(textPart.text).not.toContain('51AbCdEfGh');
    });

    it('human owner (default viewerKind) still sees everything — UX unchanged', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID);

      const json = JSON.stringify(result);
      expect(json).toContain(SECRET_TEXT);
    });

    it('un-redacted messages pass through untouched in agent mode', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', false),
          [makeTextPart('msg_1', 'normal message')],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, OWNER_ID, {
        viewerKind: 'agent',
      });

      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe('normal message');
    });

    it('non-owner + agent-viewer behaves like non-owner (mask placeholder)', () => {
      const messages = [
        makeMessageWithParts(
          makeUserMessage('msg_1', true),
          [makeTextPart('msg_1', SECRET_TEXT)],
        ),
      ];

      const result = filterRedactedForViewer(messages, OWNER_ID, NON_OWNER_ID, {
        viewerKind: 'agent',
      });

      const textPart = result[0].parts[0] as TextPart;
      expect(textPart.text).toBe('[redacted]');
      expect(textPart.text).not.toContain('4532');
    });
  });
});
