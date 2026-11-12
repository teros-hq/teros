/**
 * Session Store - Abstract interface
 *
 * Implementations should extend this to provide session storage
 */

import { extractSecretForMask, maskSecret } from '@teros/shared';
import type { Message, MessageWithParts, Part, Session, TextPart } from './types';

/**
 * Result of loading messages for LLM consumption
 */
export interface MessagesForLLM {
  /** Summary from last compaction (if any) */
  summary?: string;
  /** Messages to send to LLM (after compaction boundary) */
  messages: MessageWithParts[];
}

/**
 * MUW-F1: Filter redacted messages from LLM context for non-owners.
 *
 * When `viewerId` is provided and differs from `ownerId` (the session's
 * userId), messages marked `redacted: true` have their parts replaced with
 * a single text placeholder. This prevents the LLM from revealing redacted
 * content in responses broadcast to all channel subscribers.
 *
 * When `viewerId` is omitted (internal callers: compaction, reconciliation,
 * interruption notes), all messages are returned unfiltered.
 *
 * When `viewerId === ownerId`, the owner sees full content (click-to-reveal)
 * — EXCEPT in agent-viewer mode (see below).
 *
 * ── Agent-viewer mode (GAP 1 fix, docs/specs/20261031_agent-secret-tools.md) ──
 *
 * The LLM context build passes the channel OWNER's userId as viewerId
 * (message-handler → promptInput.userId → TurnDriver.loadProjectedMessages),
 * so "viewer == owner" is exactly the AGENT's view — and the agent is the
 * party most likely to leak a redacted secret onward. With
 * `opts.viewerKind === 'agent'`, redacted messages are replaced with a
 * masked placeholder EVEN when viewerId === ownerId:
 *
 *   [redacted: sk_live_…4f2a]
 *
 * The mask (shared `maskSecret`) is derived from the message's own content,
 * so the agent can still reference "the …4f2a key" without seeing plaintext.
 * The human owner's UI is unchanged (click-to-reveal, un-redact restores
 * agent visibility — same flag, next turn rebuilds context from the store).
 */
export function filterRedactedForViewer(
  messages: MessageWithParts[],
  ownerId: string | undefined,
  viewerId: string | undefined,
  opts?: { viewerKind?: 'human' | 'agent' },
): MessageWithParts[] {
  // No viewer context → internal use, return everything
  if (!viewerId) return messages;

  const isAgentViewer = opts?.viewerKind === 'agent';

  // Owner sees everything — unless the "viewer" is the agent acting for the
  // owner (LLM context build): the agent never gets redacted plaintext.
  if (ownerId && viewerId === ownerId && !isAgentViewer) return messages;

  // Non-owner (or agent-viewer): replace redacted message parts with placeholder
  return messages.map((msg) => {
    if (!msg.info.redacted) return msg;

    let placeholderText = '[Content redacted by the channel owner]';
    if (isAgentViewer) {
      const secret = extractSecretForMaskFromParts(msg.parts);
      placeholderText = secret
        ? `[redacted: ${maskSecret(secret)}]`
        : '[redacted]';
    }

    const placeholderPart: TextPart = {
      id: `redacted_${msg.info.id}`,
      sessionID: msg.info.sessionID,
      messageID: msg.info.id,
      type: 'text',
      text: placeholderText,
      time: { start: msg.info.time.created },
      synthetic: true,
      metadata: { redactedPlaceholder: true },
    };

    return {
      info: msg.info,
      parts: [placeholderPart],
    };
  });
}

/**
 * Find a secret-looking string in a message's parts so the agent-viewer
 * placeholder can carry its mask. Mirrors the shared `extractSecretForMask`
 * heuristic, adapted to Part shapes: text parts are scanned as-is only when
 * they look like a bare secret (rare); tool parts scan state.input /
 * state.output / state.error for secret-ish keys.
 */
function extractSecretForMaskFromParts(parts: Part[]): string | undefined {
  for (const part of parts) {
    if (part.type === 'tool') {
      const state = (part as any).state ?? {};
      const found =
        extractSecretForMask(state.input) ??
        extractSecretForMask(state.output) ??
        extractSecretForMask(state.error);
      if (found) return found;
    }
  }
  return undefined;
}

export abstract class SessionStore {
  // Basic session operations
  abstract getSession(sessionId: string): Promise<Session | undefined>;
  abstract writeSession(session: Session): Promise<void>;
  abstract deleteSession(sessionId: string): Promise<void>;
  abstract listSessions(userId: string): Promise<Session[]>;

  // Session activity
  abstract touchSession(sessionId: string): Promise<void>;

  // Message operations (matching berta-teros signatures)
  abstract writeMessage(message: Message): Promise<void>;
  abstract getMessagesWithParts(sessionId: string): Promise<MessageWithParts[]>;

  /** No-op if the message doesn't exist. */
  abstract updateUserMessageQueueState(
    messageId: string,
    state: 'pending' | 'running' | 'done',
  ): Promise<void>;

  /**
   * User messages with `queueState !== 'done'` across the given channels —
   * used at boot to re-enqueue anything left mid-flight.
   */
  abstract listPendingQueueMessages(
    channelIds: string[],
  ): Promise<Array<MessageWithParts>>;

  // Part operations (for tool use/results) (matching berta-teros signatures)
  abstract writePart(part: Part): Promise<void>;
  abstract listParts(messageId: string): Promise<Part[]>;

  // ============================================================================
  // COMPACTION OPERATIONS
  // ============================================================================

  /**
   * Get messages with compaction awareness - main method for LLM consumption
   *
   * Returns:
   * - summary: from last compaction (if any)
   * - messages: only messages AFTER the compaction boundary
   *
   * Default implementation uses legacy embedded compaction.
   * MongoSessionStore overrides this to use separate collections.
   *
   * @param viewerId - MUW-F1: when provided, redacted messages are filtered
   *   for non-owners (viewerId !== session.userId). When omitted, all
   *   messages are returned unfiltered (internal use: compaction,
   *   reconciliation, interruption notes).
   * @param opts.viewerKind - 'agent' (default 'human'): the LLM context build
   *   must pass 'agent' so redacted messages are masked even for the owner
   *   (GAP 1 fix — see filterRedactedForViewer).
   */
  async getMessagesForLLM(
    sessionId: string,
    viewerId?: string,
    opts?: { viewerKind?: 'human' | 'agent' },
  ): Promise<MessagesForLLM> {
    const session = await this.getSession(sessionId);
    const summary = session?.compaction?.summary;
    const messages = await this.getMessagesWithParts(sessionId);

    return {
      summary,
      messages: filterRedactedForViewer(messages, session?.userId, viewerId, opts),
    };
  }

  /**
   * Update the compaction summary for a session
   * @param sessionId - Session to update
   * @param summary - The compacted conversation summary
   * @param compactedMessageIds - IDs of messages that were compacted
   */
  async updateCompactionSummary(
    sessionId: string,
    summary: string,
    compactedMessageIds: string[],
    stats?: {
      messagesCompacted: number;
      tokensBefore: number;
      tokensAfter: number;
    },
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const history = session.compaction?.history || [];

    session.compaction = {
      summary,
      compactedMessageIds,
      lastCompactedAt: Date.now(),
      history: [
        ...history,
        {
          timestamp: Date.now(),
          messagesCompacted: stats?.messagesCompacted ?? compactedMessageIds.length,
          tokensBefore: stats?.tokensBefore ?? 0,
          tokensAfter: stats?.tokensAfter ?? 0,
        },
      ].slice(-10), // Keep last 10 compaction events
    };

    await this.writeSession(session);
  }

  /**
   * Get the compaction summary for a session
   * @deprecated Use getMessagesForLLM() instead
   */
  async getCompactionSummary(sessionId: string): Promise<string | undefined> {
    const { summary } = await this.getMessagesForLLM(sessionId);
    return summary;
  }
}
