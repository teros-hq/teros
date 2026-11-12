/**
 * G2 Routes — Even Realities G2 Custom AI Engine
 *
 * Implements an OpenAI-compatible chat completions endpoint at POST /g2
 * that tunnels requests to a Teros agent conversation based on a Bearer token.
 *
 * Token management:
 *   POST /g2/tokens          - Create a token linked to an agentId + userId
 *   GET  /g2/tokens          - List tokens (admin or user)
 *   DELETE /g2/tokens/:token - Revoke a token
 *
 * Chat endpoint (called by G2 app):
 *   POST /g2                 - OpenAI-compatible chat completions
 *
 * Flow:
 *   1. G2 sends POST /g2 with Bearer <token> and { model, messages[] }
 *   2. We look up the token → { agentId, userId, channelId? }
 *   3. If no channelId, create a new headless channel
 *   4. Inject the last user message into the channel via wakeUpCallback
 *   5. Poll channel_messages until agent reply appears
 *   6. Return response in OpenAI format
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { generateMessageId } from '@teros/core';
import type { ChannelId, UserId } from '@teros/shared';
import type { AgentWakeUpCallback } from '../handlers/event-handler';
import type { ChannelManager } from '../services/channel-manager';
import type { AuthService } from '../auth/auth-service';
import type { ProviderService } from '../services/provider-service';
import { canAccessAgent } from '../auth/workspace-access';
import { UpgradeRequiredError, HoursExhaustedError, PaymentDueError } from '../services/billing-gate';
import { type ApiTokenDoc, createApiToken, hashApiToken, resolveApiToken } from '../auth/api-tokens';

// ─── Types ────────────────────────────────────────────────────────────────────


interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model?: string;
  messages: OpenAIMessage[];
  channelId?: string;      // target channel for this message (multi-session mode)
}

export interface G2RoutesConfig {
  db: Db;
  channelManager: ChannelManager;
  getWakeUpCallback: () => AgentWakeUpCallback;
  authService: AuthService;
  providerService: ProviderService;
  pubSubService?: { broadcastToTopic: (topic: string, event: Record<string, unknown>) => void };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}


/**
 * Poll channel_messages for a new assistant message after a given timestamp.
 * Times out after maxWaitMs.
 */
async function waitForAgentReply(
  db: Db,
  channelId: string,
  afterTimestamp: string,
  maxWaitMs = 30000,
  pollIntervalMs = 300,
): Promise<string | null> {
  const messages = db.collection('channel_messages');
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    // Wait a bit before starting to poll to let the agent finish
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const msg = await messages.findOne(
      {
        channelId,
        role: 'assistant',
        timestamp: { $gt: afterTimestamp },
        'content.type': 'text',
        'content.text': { $exists: true, $ne: '' },
        isPartial: { $ne: true },
        // Exclude tool-related messages
        'content.toolCallId': { $exists: false },
        'content.toolName': { $exists: false },
      },
      { sort: { timestamp: -1 } }, // Most recent first — get the LAST text message
    );

    if (msg?.content?.text) {
      // Wait a bit more to make sure this is the final message (agent may still be processing)
      await new Promise(r => setTimeout(r, 1500));
      // Re-fetch to get the most recent text message after the wait
      const finalMsg = await messages.findOne(
        {
          channelId,
          role: 'assistant',
          timestamp: { $gt: afterTimestamp },
          'content.type': 'text',
          'content.text': { $exists: true, $ne: '' },
          isPartial: { $ne: true },
          'content.toolCallId': { $exists: false },
          'content.toolName': { $exists: false },
        },
        { sort: { timestamp: -1 } },
      );
      if (finalMsg?.content?.text) {
        return finalMsg.content.text as string;
      }
      return msg.content.text as string;
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  return null;
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createG2Routes(config: G2RoutesConfig) {
  const { db, channelManager, getWakeUpCallback, authService, providerService, pubSubService } = config;
  // Tokens are stored hashed (SEC-4); indexes live in migration 20261017_007
  const tokens = db.collection<ApiTokenDoc>('api_tokens');

  /**
   * Validate user session Bearer token. Returns userId or null (and sends 401).
   * NOTE: this is for the management endpoints (POST/GET/DELETE /g2/tokens).
   * The chat endpoint (POST /g2) uses its own G2 token auth, not a session token.
   */
  async function requireUserSession(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const sessionToken = authHeader.slice(7);
      const result = await authService.validateSession(sessionToken);
      if (result.success && result.user?.userId) {
        return result.user.userId;
      }
    }
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  /**
   * Main route handler. Returns true if it handled the request.
   */
  return async function handleG2Route(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const method = req.method || 'GET';

    // ── POST /g2 — Chat completions (called by G2 app, uses G2 token) ─────
    if (url === '/g2' && method === 'POST') {
      await handleChat(req, res);
      return true;
    }

    // ── POST /g2/tokens — Create a token (requires user session) ──────────
    if (url === '/g2/tokens' && method === 'POST') {
      const callerId = await requireUserSession(req, res);
      if (!callerId) return true;
      await handleCreateToken(req, res, callerId);
      return true;
    }

    // ── GET /g2/tokens — List tokens (requires user session, own tokens only)
    if (url === '/g2/tokens' && method === 'GET') {
      const callerId = await requireUserSession(req, res);
      if (!callerId) return true;
      await handleListTokens(req, res, callerId);
      return true;
    }

    // ── DELETE /g2/tokens/:token — Revoke a token (requires user session) ─
    if (url.startsWith('/g2/tokens/') && method === 'DELETE') {
      const callerId = await requireUserSession(req, res);
      if (!callerId) return true;
      const token = url.slice('/g2/tokens/'.length);
      await handleDeleteToken(req, res, token, callerId);
      return true;
    }

    return false;
  };

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleChat(req: IncomingMessage, res: ServerResponse) {
    try {
      // 1. Extract Bearer token
      const authHeader = req.headers['authorization'] || '';
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return json(res, 401, { error: { message: 'Missing Bearer token', type: 'auth_error' } });
      }
      const rawToken = match[1].trim();

      // 2. Look up token in DB (unknown token or deleted/suspended user → 401)
      const tokenDoc = await resolveApiToken(db, rawToken);
      if (!tokenDoc) {
        return json(res, 401, { error: { message: 'Invalid token', type: 'auth_error' } });
      }

      // 3. Parse request body
      const body = await readBody(req);
      let payload: OpenAIRequest;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
      }

      const messages: OpenAIMessage[] = payload.messages || [];
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) {
        return json(res, 400, { error: { message: 'No user message found', type: 'invalid_request' } });
      }

      // 3b. Billing hard gate (pre-dispatch): block before creating any channel
      // or message so the client gets a clean 402 instead of a buried error
      // bubble. resolveProviderForAgent throws on tier/hours violations.
      // NOTE: agentId may be overridden by payload.channelId — but we gate early
      // on the token's agent. If the target channel has a different agent, the
      // gate for that agent runs when the agent processes the message.
      try {
        // Gate the token actor's hours (the channel is created with tokenDoc.userId),
        // not the agent owner's (TER-650/G6).
        await providerService.resolveProviderForAgent(tokenDoc.agentId, undefined, tokenDoc.userId);
      } catch (gateErr) {
        if (
          gateErr instanceof UpgradeRequiredError ||
          gateErr instanceof HoursExhaustedError ||
          gateErr instanceof PaymentDueError
        ) {
          return json(res, 402, {
            error: { message: gateErr.message, type: 'billing_error', code: gateErr.code },
          });
        }
        throw gateErr;
      }

      // 4. Determine target channel — use channelId from body (multi-session) or token's channelId
      let channelId = payload.channelId || tokenDoc.channelId;
      let agentId = tokenDoc.agentId;

      // The token acts as its user: it may only drive agents that user can still reach.
      if (!(await canAccessAgent(db, tokenDoc.userId, tokenDoc.agentId))) {
        return json(res, 403, { error: { message: 'Token agent is not accessible', type: 'auth_error' } });
      }

      if (payload.channelId) {
        // Multi-session mode: verify the channel exists and get its agentId
        const targetChannel = await db.collection('channels').findOne({ channelId: payload.channelId });
        if (!targetChannel) {
          return json(res, 404, { error: { message: 'Channel not found', type: 'invalid_request' } });
        }
        // The channel must be one the token's user can access (SEC-2: any channelId
        // used to be accepted, letting a token drive another user's conversation).
        // No agentId is passed: being the channel's agent must not grant access.
        if (!(await channelManager.canAccessChannel(payload.channelId as ChannelId, tokenDoc.userId as UserId))) {
          return json(res, 404, { error: { message: 'Channel not found', type: 'invalid_request' } });
        }
        // If token has a workspaceId, verify the channel belongs to it
        if (tokenDoc.workspaceId && targetChannel.workspaceId !== tokenDoc.workspaceId) {
          return json(res, 403, { error: { message: 'Channel not in token workspace', type: 'auth_error' } });
        }
        channelId = payload.channelId;
        agentId = targetChannel.agentId;
      } else if (!channelId) {
        // No channel specified and token has no persisted channel — create one
        const channel = await channelManager.createChannel(
          tokenDoc.userId,
          tokenDoc.agentId,
          { name: `G2 — ${tokenDoc.label || tokenDoc.tokenPrefix}` },
          { headless: true },
        );
        channelId = channel.channelId;
        await tokens.updateOne({ tokenHash: tokenDoc.tokenHash }, { $set: { channelId } });
      }

      // 5. Save user message as visible bubble in the channel
      const beforeTimestamp = new Date().toISOString();
      
      // Get sender info for the user (same as WS handleSendMessage)
      const sender = await channelManager.getUserSender(tokenDoc.userId);
      
      const userMessage = {
        messageId: generateMessageId(),
        channelId,
        role: 'user' as const,
        userId: tokenDoc.userId,
        sender: sender || { type: 'user' as const, id: tokenDoc.userId, name: 'Unknown' },
        content: { type: 'voice' as const, transcription: lastUserMsg.content, url: '' },
        timestamp: beforeTimestamp,
        metadata: { source: 'g2' },
      };
      // Through saveMessage so the channel's lastMessageAt moves too (MOD-4)
      await channelManager.saveMessage(userMessage as never);

      // 5b. Broadcast to WebSocket subscribers so frontends update in real time
      if (pubSubService) {
        pubSubService.broadcastToTopic(`channel:${channelId}`, {
          type: 'message',
          channelId,
          message: userMessage,
        });
      }

      // 6. Wake up agent with the user message
      console.log(`[G2] Waking up agent ${agentId} on channel ${channelId} with: "${lastUserMsg.content}"`);
      const wakeUp = getWakeUpCallback();
      await wakeUp(channelId, agentId, lastUserMsg.content);

      // 7. Poll for agent reply (max 60s)
      const reply = await waitForAgentReply(db, channelId, beforeTimestamp, 60000);

      if (!reply) {
        console.log(`[G2] Timeout waiting for agent reply on channel ${channelId}`);
        return json(res, 504, { error: { message: 'Agent timed out', type: 'timeout' } });
      }

      console.log(`[G2] Sending reply to G2: "${reply.substring(0, 100)}"`);

      // 8. Return in OpenAI format
      return json(res, 200, {
        id: `g2-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'teros',
        channelId, // Include channelId so terminal knows which channel was used/created
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      console.error('[G2] Error handling chat:', err);
      return json(res, 500, { error: { message: 'Internal server error', type: 'server_error' } });
    }
  }

  async function handleCreateToken(req: IncomingMessage, res: ServerResponse, callerId: string) {
    try {
      const body = await readBody(req);
      const { agentId, label } = JSON.parse(body);

      if (!agentId) {
        return json(res, 400, { error: 'agentId is required' });
      }

      // Verify the agent exists and the caller can use it (SEC-2: any agentId was accepted)
      if (!(await canAccessAgent(db, callerId, agentId))) {
        return json(res, 404, { error: `Agent not found: ${agentId}` });
      }

      // userId is always the authenticated caller — ignore any userId in body.
      // Only the hash is stored: this response is the one time the token is shown.
      const { token, doc } = await createApiToken(db, { userId: callerId, agentId, label });

      return json(res, 201, {
        token,
        tokenId: doc.tokenId,
        agentId,
        userId: callerId,
        label: doc.label,
        createdAt: doc.createdAt,
        expiresAt: doc.expiresAt,
      });
    } catch (err) {
      console.error('[G2] Error creating token:', err);
      return json(res, 500, { error: 'Internal server error' });
    }
  }

  async function handleListTokens(req: IncomingMessage, res: ServerResponse, callerId: string) {
    try {
      // Always filter by the authenticated caller's userId — never expose other users' tokens
      const list = await tokens.find({ userId: callerId }).sort({ createdAt: -1 }).toArray();

      // The raw token is never listed (it isn't stored): id + prefix identify it
      return json(res, 200, list.map(t => ({
        tokenId: t.tokenId,
        tokenPrefix: t.tokenPrefix,
        expiresAt: t.expiresAt,
        agentId: t.agentId,
        userId: t.userId,
        label: t.label,
        channelId: t.channelId,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      })));
    } catch (err) {
      console.error('[G2] Error listing tokens:', err);
      return json(res, 500, { error: 'Internal server error' });
    }
  }

  async function handleDeleteToken(req: IncomingMessage, res: ServerResponse, token: string, callerId: string) {
    try {
      // Only allow deleting own tokens. Accepts the public tokenId or, for
      // clients that kept the raw token, the token itself (matched by hash).
      const result = await tokens.deleteOne({
        userId: callerId,
        $or: [{ tokenId: token }, { tokenHash: hashApiToken(token) }],
      });
      if (result.deletedCount === 0) {
        return json(res, 404, { error: 'Token not found' });
      }
      return json(res, 200, { ok: true, deleted: token });
    } catch (err) {
      console.error('[G2] Error deleting token:', err);
      return json(res, 500, { error: 'Internal server error' });
    }
  }
}
