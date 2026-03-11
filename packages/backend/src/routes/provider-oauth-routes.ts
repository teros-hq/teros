/**
 * Provider OAuth Routes
 *
 * HTTP endpoints for user provider OAuth flows.
 * Currently supports:
 * - Anthropic (Claude Max subscription)
 *
 * Flow:
 * 1. Frontend calls /api/providers/oauth/anthropic/start?userId=xxx
 * 2. Backend generates auth URL with PKCE, stores verifier in session
 * 3. User is redirected to claude.ai to authorize
 * 4. User copies callback URL and pastes it in frontend
 * 5. Frontend calls /api/providers/oauth/anthropic/callback with the URL
 * 6. Backend exchanges code for tokens and creates the provider
 *
 * Note: Anthropic uses a "copy callback URL" flow, not a direct redirect,
 * because the redirect_uri is console.anthropic.com, not our domain.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import {
  exchangeCodeForTokens,
  generateAuthorizationUrl,
} from '@teros/core';
import { ProviderService } from '../services/provider-service';

// ============================================================================
// TYPES
// ============================================================================

export interface ProviderOAuthRoutesConfig {
  db: Db;
}

interface OAuthSession {
  verifier: string;
  userId: string;
  createdAt: number;
}

// In-memory store for OAuth sessions (verifier -> userId mapping)
// In production, this should be Redis or similar
const oauthSessions = new Map<string, OAuthSession>();

// Clean up old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  for (const [key, session] of oauthSessions.entries()) {
    if (now - session.createdAt > maxAge) {
      oauthSessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return params;
  
  const queryString = url.slice(queryStart + 1);
  for (const pair of queryString.split('&')) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    }
  }
  return params;
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Start OAuth flow for Anthropic
 * GET /api/providers/oauth/anthropic/start?userId=xxx
 *
 * Returns the authorization URL to open in browser
 */
async function handleAnthropicStart(
  _req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!userId) {
    sendError(res, 400, 'userId is required');
    return;
  }

  try {
    // Generate authorization URL with PKCE
    const { url, verifier } = generateAuthorizationUrl();

    // Store verifier for later exchange
    oauthSessions.set(verifier, {
      verifier,
      userId,
      createdAt: Date.now(),
    });

    console.log(`[ProviderOAuth] Started Anthropic OAuth for user ${userId}`);

    sendJson(res, 200, {
      authUrl: url,
      verifier, // Frontend needs this to complete the flow
      instructions: 'Open authUrl in browser, authorize, then copy the callback URL and call /callback',
    });
  } catch (error) {
    console.error('[ProviderOAuth] Error starting OAuth:', error);
    sendError(res, 500, 'Failed to start OAuth flow');
  }
}

/**
 * Complete OAuth flow for Anthropic
 * POST /api/providers/oauth/anthropic/callback
 * Body: { callbackUrl: string, verifier: string }
 *
 * Exchanges the code for tokens and creates the provider
 */
async function handleAnthropicCallback(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProviderOAuthRoutesConfig,
): Promise<void> {
  try {
    const body = await parseBody<{ callbackUrl: string; verifier: string }>(req);
    const { callbackUrl, verifier } = body;

    if (!callbackUrl || !verifier) {
      sendError(res, 400, 'callbackUrl and verifier are required');
      return;
    }

    // Get session
    const session = oauthSessions.get(verifier);
    if (!session) {
      sendError(res, 400, 'Invalid or expired verifier. Please start the OAuth flow again.');
      return;
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(callbackUrl, verifier);
    if (!tokens) {
      sendError(res, 400, 'Failed to exchange code for tokens. Please try again.');
      return;
    }

    // Clean up session
    oauthSessions.delete(verifier);

    // Create provider service and add the provider
    const providerService = new ProviderService(config.db);

    // Check if user already has an anthropic-oauth provider
    const existingProviders = await providerService.listUserProviders(session.userId);
    const existing = existingProviders.find(p => p.providerType === 'anthropic-oauth');

    if (existing) {
      // Update existing provider with new tokens
      await providerService.updateProvider(session.userId, existing.providerId, {
        auth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      });

      console.log(`[ProviderOAuth] Updated Anthropic OAuth provider for user ${session.userId}`);

      sendJson(res, 200, {
        success: true,
        providerId: existing.providerId,
        message: 'Claude Max provider updated successfully',
      });
    } else {
      // Create new provider
      const provider = await providerService.addProvider(session.userId, {
        providerType: 'anthropic-oauth',
        displayName: 'Claude Max',
        auth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      });

      console.log(`[ProviderOAuth] Created Anthropic OAuth provider for user ${session.userId}`);

      sendJson(res, 200, {
        success: true,
        providerId: provider.providerId,
        message: 'Claude Max provider connected successfully',
      });
    }
  } catch (error) {
    console.error('[ProviderOAuth] Error completing OAuth:', error);
    sendError(res, 500, 'Failed to complete OAuth flow');
  }
}

// ============================================================================
// ROUTER
// ============================================================================

export function createProviderOAuthRoutes(config: ProviderOAuthRoutesConfig) {
  return async function handleProviderOAuth(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return true;
    }

    // Route: GET /api/providers/oauth/anthropic/start
    if (path === '/api/providers/oauth/anthropic/start' && req.method === 'GET') {
      const params = parseQueryParams(req.url || '');
      await handleAnthropicStart(req, res, params.userId);
      return true;
    }

    // Route: POST /api/providers/oauth/anthropic/callback
    if (path === '/api/providers/oauth/anthropic/callback' && req.method === 'POST') {
      await handleAnthropicCallback(req, res, config);
      return true;
    }

    return false;
  };
}
