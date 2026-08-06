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

import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { generateMessageId } from '@teros/core';
import type { AgentWakeUpCallback } from '../handlers/event-handler';
import type { ChannelManager } from '../services/channel-manager';
import type { AuthService } from '../auth/auth-service';
import type { ProviderService } from '../services/provider-service';
import { UpgradeRequiredError, HoursExhaustedError, PaymentDueError } from '../services/billing-gate';

// ─── Types ────────────────────────────────────────────────────────────────────

interface G2Token {
  token: string;
  agentId: string;
  userId: string;
  channelId?: string;      // persisted channel for this token (one per token)
  label?: string;          // friendly name e.g. "My G2 glasses"
  createdAt: string;
  lastUsedAt?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model?: string;
  messages: OpenAIMessage[];
}

export interface G2RoutesConfig {
  db: Db;
  channelManager: ChannelManager;
  getWakeUpCallback: () => AgentWakeUpCallback;
  authService: AuthService;
  providerService: ProviderService;
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

function generateToken(): string {
  // Use cryptographically-secure randomness (fixes C-4 — Math.random() is predictable)
  return 'g2_' + randomBytes(24).toString('hex');
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
  const { db, channelManager, getWakeUpCallback, authService, providerService } = config;
  const tokens = db.collection<G2Token>('g2_tokens');

  // Ensure index on token field
  tokens.createIndex({ token: 1 }, { unique: true }).catch(() => {}); // intentional: index may already exist — cleanup only

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

      // 2. Look up token in DB
      const tokenDoc = await tokens.findOne({ token: rawToken });
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

      // 4. Get or create a persistent channel for this token
      let channelId = tokenDoc.channelId;
      if (!channelId) {
        const channel = await channelManager.createChannel(
          tokenDoc.userId,
          tokenDoc.agentId,
          { name: `G2 — ${tokenDoc.label || rawToken.slice(0, 12)}` },
          { headless: true },
        );
        channelId = channel.channelId;
        await tokens.updateOne({ token: rawToken }, { $set: { channelId } });
      }

      // 5. Save user message as visible bubble in the channel
      const beforeTimestamp = new Date().toISOString();
      await db.collection('channel_messages').insertOne({
        messageId: generateMessageId(),
        channelId,
        role: 'user',
        content: lastUserMsg.content,
        timestamp: beforeTimestamp,
        metadata: { source: 'g2' },
      });

      // 6. Wake up agent with the user message
      console.log(`[G2] Waking up agent ${tokenDoc.agentId} on channel ${channelId} with: "${lastUserMsg.content}"`);
      const wakeUp = getWakeUpCallback();
      await wakeUp(channelId, tokenDoc.agentId, lastUserMsg.content);

      // 7. Update lastUsedAt
      await tokens.updateOne({ token: rawToken }, { $set: { lastUsedAt: new Date().toISOString() } });

      // 8. Poll for agent reply (max 60s)
      const reply = await waitForAgentReply(db, channelId, beforeTimestamp, 60000);

      if (!reply) {
        console.log(`[G2] Timeout waiting for agent reply on channel ${channelId}`);
        return json(res, 504, { error: { message: 'Agent timed out', type: 'timeout' } });
      }

      console.log(`[G2] Sending reply to G2: "${reply.substring(0, 100)}"`);

      // 9. Return in OpenAI format
      return json(res, 200, {
        id: `g2-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'teros',
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

      // Verify agent exists
      const agent = await db.collection('agents').findOne({ agentId });
      if (!agent) {
        return json(res, 404, { error: `Agent not found: ${agentId}` });
      }

      // userId is always the authenticated caller — ignore any userId in body
      const token = generateToken();
      const doc: G2Token = {
        token,
        agentId,
        userId: callerId,
        label: label || undefined,
        createdAt: new Date().toISOString(),
      };

      await tokens.insertOne(doc);

      return json(res, 201, {
        token,
        agentId,
        userId: callerId,
        label: doc.label,
        createdAt: doc.createdAt,
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

      return json(res, 200, list.map(t => ({
        token: t.token,
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
      // Only allow deleting own tokens
      const result = await tokens.deleteOne({ token, userId: callerId });
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
