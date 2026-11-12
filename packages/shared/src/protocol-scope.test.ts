/**
 * MUW-1 — Channel scope & message redaction schema tests.
 *
 * Verifies:
 * - ChannelSchema accepts `scope: 'personal' | 'shared'`
 * - ChannelSchema accepts channels without `scope` (default personal in runtime, NFR-3)
 * - MessageSchema accepts `redacted`, `redactedBy`, `redactedAt`
 * - MessageSchema accepts messages without redaction fields (backward compat)
 */

import { describe, expect, it } from 'bun:test';
import { ChannelSchema, MessageSchema } from './protocol.js';

describe('MUW-1: ChannelSchema scope', () => {
  const baseChannel = {
    channelId: 'ch_test1',
    userId: 'user_test1',
    agentId: 'agent_test1',
    status: 'active' as const,
    metadata: { transport: 'websocket' as const },
    createdAt: '2026-09-14T20:00:00.000Z',
    updatedAt: '2026-09-14T20:00:00.000Z',
    workspaceId: 'work_test1',
  };

  it('accepts scope: "personal"', () => {
    const result = ChannelSchema.safeParse({
      ...baseChannel,
      scope: 'personal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('personal');
    }
  });

  it('accepts scope: "shared"', () => {
    const result = ChannelSchema.safeParse({
      ...baseChannel,
      scope: 'shared',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('shared');
    }
  });

  it('accepts channel without scope field (default personal in runtime)', () => {
    const result = ChannelSchema.safeParse(baseChannel);
    expect(result.success).toBe(true);
    if (result.success) {
      // scope should be undefined — runtime treats missing as 'personal'
      expect(result.data.scope).toBeUndefined();
    }
  });

  it('rejects invalid scope value', () => {
    const result = ChannelSchema.safeParse({
      ...baseChannel,
      scope: 'secret',
    });
    expect(result.success).toBe(false);
  });
});

describe('MUW-1: MessageSchema redaction fields', () => {
  const baseMessage = {
    messageId: 'msg_test1',
    channelId: 'ch_test1',
    role: 'user' as const,
    content: { type: 'text' as const, text: 'hello' },
    timestamp: '2026-09-14T20:00:00.000Z',
  };

  it('accepts redacted message with all fields', () => {
    const result = MessageSchema.safeParse({
      ...baseMessage,
      redacted: true,
      redactedBy: 'user_test1',
      redactedAt: '2026-09-14T21:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redacted).toBe(true);
      expect(result.data.redactedBy).toBe('user_test1');
      expect(result.data.redactedAt).toBe('2026-09-14T21:00:00.000Z');
    }
  });

  it('accepts message without redaction fields (backward compat)', () => {
    const result = MessageSchema.safeParse(baseMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redacted).toBeUndefined();
      expect(result.data.redactedBy).toBeUndefined();
      expect(result.data.redactedAt).toBeUndefined();
    }
  });

  it('accepts partially redacted message (only redacted flag)', () => {
    const result = MessageSchema.safeParse({
      ...baseMessage,
      redacted: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redacted).toBe(true);
    }
  });
});
