/**
 * Terminal Provider — Even Terminal's 9-method provider interface,
 * backed by Teros agent conversations.
 *
 * Each "session" in Even Terminal maps to a Teros channel. The provider
 * translates between Even Terminal's REST/SSE vocabulary and Teros's
 * channel + wakeUpCallback mechanism.
 *
 * The 9 methods (matching even-terminal's createXProvider(emit) convention):
 *   1. listSessions        — list Teros channels for the token's agent
 *   2. getSessionStatus    — idle / busy / awaiting
 *   3. getInfo             — agent info (name, model, version)
 *   4. getHistory          — channel message history
 *   5. prompt              — send a message to the agent
 *   6. respondPermission   — respond to a tool permission request
 *   7. respondQuestion     — respond to a user question (form/input)
 *   8. interrupt           — cancel the running agent turn
 *   9. getStatus           — synchronous status check
 */

import type { Db } from 'mongodb';
import { generateMessageId } from '@teros/core';
import type { AgentWakeUpCallback } from '../handlers/event-handler';
import type { ChannelManager } from '../services/channel-manager';
import { emit as busEmit, pushMessage, getMessages } from './terminal-bus';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The Even app only knows "claude" and "codex" as provider labels and
 * FILTERS its session list by provider. We present as "claude" so sessions
 * are visible; Teros runs underneath regardless.
 */
const PROVIDER_NAME = 'claude';
const REAL_PROVIDER = 'teros';

export interface TerminalSession {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: string;
  status: string;
}

export interface TerminalInfo {
  account: Record<string, any>;
  model: string;
  version: string;
  provider: string;
}

export interface TerminalHistoryEntry {
  role: string;
  content: string;
  timestamp: string;
}

export interface TerminalProviderConfig {
  db: Db;
  channelManager: ChannelManager;
  getWakeUpCallback: () => AgentWakeUpCallback;
  /** agentId + userId resolved from the G2 token at auth time */
  agentId: string;
  userId: string;
  /** channelId persisted on the G2 token (created on first use) */
  getChannelId: () => string | undefined;
  setChannelId: (channelId: string) => Promise<void>;
  /**
   * Resolve a permission request via the in-memory PermissionManager.
   * Called when the G2 Terminal user taps "Allow" or "Deny".
   * Delegates to messageHandler.handlePermissionResponse(requestId, granted)
   * which resolves the promise the agent loop is awaiting.
   */
  resolvePermission?: (requestId: string, granted: boolean) => Promise<void>;
}

// ─── Session tracking ──────────────────────────────────────────────────────────

interface LiveSession {
  channelId: string;
  status: 'idle' | 'busy' | 'awaiting';
  turnStartMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** Pending permission request IDs (tool calls awaiting approval) */
  pendingPermissions: string[];
  /** Pending question/form request IDs */
  pendingQuestions: string[];
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createTerminalProvider(config: TerminalProviderConfig) {
  const { db, channelManager, getWakeUpCallback, agentId, userId, getChannelId, setChannelId, resolvePermission } = config;

  // Live session state (one per channel)
  const liveSessions = new Map<string, LiveSession>();

  function getLiveSession(channelId: string): LiveSession | undefined {
    return liveSessions.get(channelId);
  }

  function ensureLiveSession(channelId: string): LiveSession {
    let session = liveSessions.get(channelId);
    if (!session) {
      session = {
        channelId,
        status: 'idle',
        turnStartMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
        pendingPermissions: [],
        pendingQuestions: [],
      };
      liveSessions.set(channelId, session);
    }
    return session;
  }

  // ── 1. listSessions ──────────────────────────────────────────────────────

  async function listSessions(limit: number, _cwd?: string): Promise<TerminalSession[]> {
    const channelId = getChannelId();
    const sessions: TerminalSession[] = [];

    if (channelId) {
      // Get channel info
      const channel = await db.collection('channels').findOne({ channelId });
      const live = getLiveSession(channelId);
      sessions.push({
        id: channelId,
        title: channel?.name || 'Teros Session',
        timestamp: channel?.lastMessageAt || new Date().toISOString(),
        cwd: '',
        provider: PROVIDER_NAME,
        status: live?.status || 'idle',
      });
    }

    return sessions.slice(0, limit);
  }

  // ── 2. getSessionStatus ──────────────────────────────────────────────────

  async function getSessionStatus(sessionId: string): Promise<string> {
    const live = getLiveSession(sessionId);
    if (live) {
      if (live.pendingPermissions.length > 0 || live.pendingQuestions.length > 0) {
        return 'awaiting';
      }
      return live.status;
    }
    // Not live in this process — persisted sessions are idle
    return 'idle';
  }

  // ── 3. getInfo ───────────────────────────────────────────────────────────

  async function getInfo(): Promise<TerminalInfo> {
    const agent = await db.collection('agents').findOne({ agentId });
    return {
      account: {},
      model: agent?.model || 'teros-default',
      version: '1.0.0',
      provider: PROVIDER_NAME,
    };
  }

  // ── 4. getHistory ────────────────────────────────────────────────────────

  async function getHistory(sessionId: string, limit: number): Promise<TerminalHistoryEntry[]> {
    const messages = await db
      .collection('channel_messages')
      .find({
        channelId: sessionId,
        role: { $in: ['user', 'assistant'] },
        'content.type': 'text',
        'content.text': { $exists: true, $ne: '' },
        isPartial: { $ne: true },
        'content.toolCallId': { $exists: false },
        'content.toolName': { $exists: false },
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // Reverse to chronological order
    return messages.reverse().map((msg) => ({
      role: msg.role,
      content: msg.content?.text || '',
      timestamp: msg.timestamp,
    }));
  }

  // ── 5. prompt ────────────────────────────────────────────────────────────

  async function prompt(
    sessionId: string | undefined,
    text: string,
    _cwd?: string,
  ): Promise<{ sessionId: string; provider: string }> {
    // Get or create channel
    let channelId = sessionId || getChannelId();
    if (!channelId) {
      const channel = await channelManager.createChannel(
        userId,
        agentId,
        { name: `G2 Terminal — ${text.slice(0, 30)}` },
        { headless: true },
      );
      channelId = channel.channelId;
      await setChannelId(channelId);
    }

    const session = ensureLiveSession(channelId);

    // If awaiting a question, route the text as the answer
    if (session.pendingQuestions.length > 0) {
      respondQuestion(channelId, text);
      return { sessionId: channelId, provider: PROVIDER_NAME };
    }

    // Save user message as visible bubble
    // Through saveMessage (moves the channel's lastMessageAt) and with the
    // schema's content/sender shape — it was a plain string with no sender (MOD-4)
    const beforeTimestamp = new Date().toISOString();
    const sender = await channelManager.getUserSender(userId);
    await channelManager.saveMessage({
      messageId: generateMessageId(),
      channelId,
      role: 'user',
      userId,
      sender: sender || { type: 'user', id: userId, name: 'Unknown' },
      content: { type: 'text', text },
      timestamp: beforeTimestamp,
      metadata: { source: 'g2-terminal' },
    } as never);

    // Emit user_prompt echo to SSE
    busEmit(channelId, { type: 'user_prompt', text });

    // Mark as busy
    session.status = 'busy';
    session.turnStartMs = Date.now();
    session.inputTokens = 0;
    session.outputTokens = 0;
    session.costUsd = 0;
    session.turns = 0;

    busEmit(channelId, { type: 'status', state: 'busy', sessionId: channelId });

    // Wake up agent
    console.log(`[Terminal] Waking up agent ${agentId} on channel ${channelId} with: "${text.slice(0, 80)}"`);
    const wakeUp = getWakeUpCallback();
    wakeUp(channelId, agentId, text).catch((err) => {
      console.error(`[Terminal] WakeUp error: ${err?.message ?? err}`);
      session.status = 'idle';
      busEmit(channelId, { type: 'error', message: `Agent error: ${err?.message ?? 'unknown'}` });
      busEmit(channelId, { type: 'status', state: 'idle', sessionId: channelId });
    });

    return { sessionId: channelId, provider: PROVIDER_NAME };
  }

  // ── 6. respondPermission ─────────────────────────────────────────────────

  async function respondPermission(sessionId: string, decision: string): Promise<void> {
    const session = getLiveSession(sessionId);
    if (!session) return;

    const reqId = session.pendingPermissions.shift();
    if (!reqId) return;

    // Map Even Terminal decision values to granted/denied
    const granted = decision === 'allow' || decision === 'allowAlways';

    // Resolve the permission via the in-memory PermissionManager.
    // This calls messageHandler.handlePermissionResponse(requestId, granted)
    // which resolves the promise the agent loop is awaiting — unblocking the turn.
    if (resolvePermission) {
      try {
        await resolvePermission(reqId, granted);
        console.log(`[Terminal] Permission ${granted ? 'granted' : 'denied'} for request ${reqId} on session ${sessionId}`);
      } catch (err) {
        console.error(`[Terminal] Error resolving permission ${reqId}:`, err);
      }
    } else {
      console.warn('[Terminal] resolvePermission not configured — permission will not be resolved');
    }

    // Emit permission result to SSE
    busEmit(sessionId, {
      type: 'permission_result',
      toolName: 'tool',
      summary: '',
      decision: decision === 'deny' ? 'denied' : decision === 'allowAlways' ? 'always' : 'allowed',
    });

    // Update session status — if no more pending permissions/questions, go back to busy
    if (session.pendingPermissions.length === 0 && session.pendingQuestions.length === 0) {
      session.status = 'busy';
      busEmit(sessionId, { type: 'status', state: 'busy', sessionId });
    }
  }

  // ── 7. respondQuestion ───────────────────────────────────────────────────

  function respondQuestion(sessionId: string, answer: string): void {
    const session = getLiveSession(sessionId);
    if (!session) return;

    const reqId = session.pendingQuestions.shift();
    if (!reqId) return;

    // Update the form response in the DB
    db.collection('pending_forms').updateOne(
      { requestId: reqId },
      { $set: { response: answer, resolvedAt: new Date().toISOString() } },
    ).catch((err) => console.error(`[Terminal] Error resolving question: ${err}`));

    busEmit(sessionId, {
      type: 'question_answer',
      answers: { '': answer },
    });
  }

  // ── 8. interrupt ─────────────────────────────────────────────────────────

  function interrupt(sessionId: string): void {
    const session = getLiveSession(sessionId);
    if (!session) return;

    // Clear pending dialogs
    session.pendingPermissions = [];
    session.pendingQuestions = [];

    // Mark as idle — the agent loop will detect the interrupt
    session.status = 'idle';

    busEmit(sessionId, { type: 'status', state: 'idle', sessionId });
  }

  // ── 9. getStatus ─────────────────────────────────────────────────────────

  function getStatus(sessionId: string): { state: string; provider: string } | null {
    const session = getLiveSession(sessionId);
    if (!session) return null;

    let state = session.status;
    if (session.pendingPermissions.length > 0 || session.pendingQuestions.length > 0) {
      state = 'awaiting';
    }

    return { state, provider: PROVIDER_NAME };
  }

  // ── Public: receive events from the Teros broadcast system ────────────────

  /**
   * Called when the Teros backend broadcasts a message_chunk or other event
   * to the channel. Translates it to Even Terminal's normalized events and
   * emits via the SSE bus.
   */
  function onChannelEvent(channelId: string, event: any): void {
    const session = ensureLiveSession(channelId);

    if (event.type === 'message_chunk') {
      if (event.chunkType === 'text_chunk') {
        // Emit text_delta for streaming text
        busEmit(channelId, { type: 'text_delta', text: event.text });
      } else if (event.chunkType === 'tool_call_start') {
        busEmit(channelId, {
          type: 'tool_start',
          name: event.toolName,
          toolId: event.toolCallId,
        });
      } else if (event.chunkType === 'tool_call_complete') {
        busEmit(channelId, {
          type: 'tool_end',
          name: event.toolName,
          toolId: event.toolCallId,
          summary: '',
          detail: { input: event.toolInput, output: event.toolOutput },
        });
      }
    } else if (event.type === 'message') {
      // A complete message was saved to DB
      if (event.message?.role === 'assistant' && event.message?.content?.type === 'text') {
        // The text was already streamed via text_chunk events above.
        // Check if this is the final message (turn complete)
        if (session.status === 'busy') {
          session.turns += 1;
          session.status = 'idle';
          busEmit(channelId, {
            type: 'result',
            success: true,
            text: '',
            sessionId: channelId,
            costUsd: session.costUsd,
            provider: PROVIDER_NAME,
            turns: session.turns,
            durationMs: session.turnStartMs ? Date.now() - session.turnStartMs : 0,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          });
          busEmit(channelId, { type: 'status', state: 'idle', sessionId: channelId });
        }
      } else if (event.message?.content?.type === 'tool') {
        // Tool message — check for permission request
        if (event.message?.content?.status === 'pending_permission') {
          const reqId = event.message.content.permissionRequestId || event.message.messageId;
          session.pendingPermissions.push(reqId);
          const toolName = event.message.content.toolName || 'tool';
          busEmit(channelId, {
            type: 'permission_request',
            toolName,
            // Even Terminal shows `description` as the title on the G2 display.
            // Provide a human-readable prompt so the user knows what they're approving.
            description: `Allow ${toolName}?`,
            detail: JSON.stringify(event.message.content.input || {}),
            toolUseId: reqId,
            options: [
              { text: 'Allow', key: 'allow' },
              { text: 'Deny', key: 'deny' },
            ],
          });
        }
      }
    } else if (event.type === 'typing') {
      // Typing indicator — already handled by busy status
    } else if (event.type === 'error') {
      session.status = 'idle';
      busEmit(channelId, { type: 'error', message: event.message || 'unknown error' });
      busEmit(channelId, { type: 'status', state: 'idle', sessionId: channelId });
    }
  }

  // ── Return the 9-method provider object ──────────────────────────────────

  return {
    listSessions,
    getSessionStatus,
    getInfo,
    getHistory,
    prompt,
    respondPermission,
    respondQuestion,
    interrupt,
    getStatus,
    // Internal: used by the route handler to feed channel events
    onChannelEvent,
  };
}

export type TerminalProvider = ReturnType<typeof createTerminalProvider>;
