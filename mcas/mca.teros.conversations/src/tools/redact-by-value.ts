import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient, isWsConnected } from '../lib';

/**
 * redact-by-value — agent secret tools (docs/specs/20261031_agent-secret-tools.md).
 *
 * Standalone value-based redaction primitive. Self-redacting: this tool's own
 * call (whose arguments contain the value) is swept like any other message.
 *
 * `alwaysAsk: true` — redacting conversation content on the user's behalf
 * always requires explicit confirmation.
 */
export const redactByValue: ToolConfig = {
  description:
    "Redact every message in a conversation that contains a given secret value — the message where it was pasted, tool outputs like SSH/terminal logs that captured it, your own echoes, and even the arguments of this very call. Use it when a secret leaked into the conversation and you want no trace of it left in plaintext. The owner can still un-redact any message. Returns a coverage report (message ids + count) so you can verify nothing was missed. NEVER use this to hide non-secret content — it is a safety primitive for credentials.",
  parameters: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        description:
          'The exact secret text to sweep for (minimum 4 characters). Every message containing it will be redacted.',
      },
      channelId: {
        type: 'string',
        description:
          'The conversation to sweep (default: the current one). Only channels you have access to.',
      },
      window: {
        type: 'number',
        description: 'How many recent messages to scan (default 200, max 1000).',
      },
      alsoRedact: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Extra message ids to redact when the exact match misses them (split key, transformed value).',
      },
    },
    required: ['value'],
  },
  // Policy flag: redacting conversation history on the user's behalf always
  // asks — never auto-runs.
  annotations: { readOnlyHint: false, alwaysAsk: true },
  handler: async (args, context: ToolContext) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const value = args?.value as string;
    if (!value || typeof value !== 'string') {
      throw new Error('value is required');
    }
    if (value.length < 4) {
      throw new Error('value is too short to sweep safely (minimum 4 characters)');
    }

    const channelId = (args?.channelId as string) || CURRENT_CHANNEL_ID;
    if (!channelId) {
      throw new Error('channelId is required (no current channel in context)');
    }

    const result = await wsClient.queryConversations<any>('redact_by_value', {
      channelId,
      value,
      ...(args?.window ? { window: args.window as number } : {}),
      ...(Array.isArray(args?.alsoRedact) ? { alsoRedact: args.alsoRedact as string[] } : {}),
      agentId: context.execution.agentId,
      // Caller channel — the backend uses it for the personal/shared scope gate.
      callerChannelId: context.execution.channelId,
    });

    return {
      success: true,
      channelId: result.channelId,
      redactedCount: result.redactedCount,
      messageIds: result.messageIds,
      sessionDocsFlagged: result.sessionDocsFlagged,
      surfaces: result.surfaces,
      alsoRedacted: result.alsoRedacted,
      note: result.note,
    };
  },
};
