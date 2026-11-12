/**
 * Provider Commands Handler
 *
 * Handles WebSocket commands for user-managed LLM providers:
 * - list_providers: List user's providers
 * - add_provider: Add a new provider with API key
 * - test_provider: Test connection and discover models
 * - update_provider: Update provider settings (displayName, priority, status)
 * - delete_provider: Remove a provider
 *
 * The legacy agent-providers commands (list_agent_providers /
 * set_agent_providers / set_agent_preferred_provider) were removed on
 * 2026-10-21 with the availableProviders concept — they were never registered
 * on any router (dead code). Agent model config lives in the agent domain:
 * agent.list-providers / agent.set-model.
 */

import type { WebSocket } from 'ws';
import type { Db } from 'mongodb';
import type { AuthManager } from '../../auth/auth-manager';
import { isProviderTypeAllowedInEdition } from '@teros/shared';
import type { ProviderService, UserProviderRecord } from '../../services/provider-service';
import { PROVIDER_TYPES_WITHOUT_SECRETS } from '../../services/provider-service';
import { VALID_PROVIDER_TYPES } from '../domains/provider/add';
import type { CommandDeps } from './types';

export interface ProviderCommandsDeps extends CommandDeps {
  db: Db;
  providerService: ProviderService;
  authManager?: AuthManager | null;
}

export function createProviderCommands(deps: ProviderCommandsDeps) {
  const { db, providerService, authManager, sendMessage, sendError } = deps;
  void authManager; // reserved for future oauth flows, not used yet

  return {
    /**
     * Handle list_providers - list all providers for the user
     */
    async handleListProviders(ws: WebSocket, userId: string): Promise<void> {
      try {
        const providers = await providerService.listUserProviders(userId);

        // Strip encrypted data before sending to client
        const sanitized = providers.map((p) => ({
          providerId: p.providerId,
          providerType: p.providerType,
          displayName: p.displayName,
          config: p.config,
          models: p.models,
          priority: p.priority,
          status: p.status,
          lastTestedAt: p.lastTestedAt,
          errorMessage: p.errorMessage,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));

        sendMessage(ws, {
          type: 'providers_list',
          providers: sanitized,
        } as any);
      } catch (error) {
        console.error('❌ Error listing providers:', error);
        sendError(ws, 'LIST_PROVIDERS_ERROR', 'Failed to list providers');
      }
    },

    /**
     * Handle add_provider - add a new provider with credentials
     */
    async handleAddProvider(
      ws: WebSocket,
      userId: string,
      message: {
        providerType: string;
        displayName: string;
        config?: Record<string, any>;
        auth?: { apiKey?: string };
      },
    ): Promise<void> {
      try {
        const { providerType, displayName, config, auth } = message;

        if (!providerType || !displayName) {
          sendError(ws, 'INVALID_INPUT', 'providerType and displayName are required');
          return;
        }

        // Validate providerType — import VALID_TYPES from add.ts keeps a single list
        if (!VALID_PROVIDER_TYPES.includes(providerType)) {
          sendError(ws, 'INVALID_PROVIDER_TYPE', `Invalid providerType: ${providerType}`);
          return;
        }

        // Edition gate (TER-EDITION): parity with the provider.add domain handler —
        // local Ollama is self-hosted-only, rejected before any record is created.
        if (!isProviderTypeAllowedInEdition(providerType)) {
          sendError(
            ws,
            'PROVIDER_NOT_AVAILABLE_IN_EDITION',
            `Provider type '${providerType}' (local Ollama daemon) is only available in the self-hosted edition. ` +
              `On Teros cloud, use the 'ollama-cloud' provider (hosted models, API key from ollama.com) instead.`,
          );
          return;
        }

        // Create provider record (skeleton - secrets encryption will be added)
        const provider = await providerService.addProvider(userId, {
          providerType: providerType as any,
          displayName,
          config,
        });

        // Credential-free providers — test immediately to discover models
        if (PROVIDER_TYPES_WITHOUT_SECRETS.includes(providerType as any)) {
          try {
            const testResult = await providerService.testProvider(provider.providerId);
            sendMessage(ws, {
              type: 'provider_added',
              provider: {
                providerId: provider.providerId,
                providerType: provider.providerType,
                displayName: provider.displayName,
                status: provider.status,
                priority: provider.priority,
                test: testResult,
              },
            } as any);
          } catch (err) {
            console.error('[ProviderCommands] Failed to test Ollama provider:', err);
            sendMessage(ws, {
              type: 'provider_added',
              provider: {
                providerId: provider.providerId,
                providerType: provider.providerType,
                displayName: provider.displayName,
                status: 'error',
                priority: provider.priority,
              },
            } as any);
          }
          return;
        }

        // If an API key was provided, encrypt and store it via ProviderService
        if (auth?.apiKey) {
          try {
            await providerService.setProviderSecrets(userId, provider.providerId, { apiKey: auth.apiKey });
            // Attempt an automatic test to discover models (optional)
            const testResult = await providerService.testProvider(provider.providerId);
            sendMessage(ws, {
              type: 'provider_added',
              provider: {
                providerId: provider.providerId,
                providerType: provider.providerType,
                displayName: provider.displayName,
                status: provider.status,
                priority: provider.priority,
                test: testResult,
              },
            } as any);
          } catch (err) {
            console.error('[ProviderCommands] Failed to store provider secrets:', err);
            sendMessage(ws, {
              type: 'provider_added',
              provider: {
                providerId: provider.providerId,
                providerType: provider.providerType,
                displayName: provider.displayName,
                status: provider.status,
                priority: provider.priority,
              },
            } as any);
          }
        } else {
          sendMessage(ws, {
            type: 'provider_added',
            provider: {
              providerId: provider.providerId,
              providerType: provider.providerType,
              displayName: provider.displayName,
              status: provider.status,
              priority: provider.priority,
            },
          } as any);
        }

        console.log(`✅ Added provider ${provider.providerId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error adding provider:', error);
        sendError(ws, 'ADD_PROVIDER_ERROR', 'Failed to add provider');
      }
    },

    /**
     * Handle test_provider - test connection and discover models
     */
    async handleTestProvider(
      ws: WebSocket,
      userId: string,
      message: { providerId: string },
    ): Promise<void> {
      try {
        const { providerId } = message;

        if (!providerId) {
          sendError(ws, 'MISSING_PROVIDER_ID', 'providerId is required');
          return;
        }

        // Verify ownership
        const providers = await providerService.listUserProviders(userId);
        const owned = providers.find((p) => p.providerId === providerId);
        if (!owned) {
          sendError(ws, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
          return;
        }

        const result = await providerService.testProvider(providerId);

        sendMessage(ws, {
          type: 'provider_tested',
          providerId,
          ok: result.ok,
          models: result.models,
          error: result.error,
        } as any);
      } catch (error) {
        console.error('❌ Error testing provider:', error);
        sendError(ws, 'TEST_PROVIDER_ERROR', 'Failed to test provider');
      }
    },

    /**
     * Handle update_provider - update provider settings
     */
    async handleUpdateProvider(
      ws: WebSocket,
      userId: string,
      message: {
        providerId: string;
        displayName?: string;
        priority?: number;
        status?: 'active' | 'disabled';
      },
    ): Promise<void> {
      try {
        const { providerId, displayName, priority, status } = message;

        if (!providerId) {
          sendError(ws, 'MISSING_PROVIDER_ID', 'providerId is required');
          return;
        }

        // Verify ownership
        const providers = await providerService.listUserProviders(userId);
        const owned = providers.find((p) => p.providerId === providerId);
        if (!owned) {
          sendError(ws, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
          return;
        }

        // Build update
        const updates: Partial<UserProviderRecord> = { updatedAt: new Date().toISOString() };
        if (displayName !== undefined) updates.displayName = displayName;
        if (priority !== undefined) updates.priority = priority;
        if (status !== undefined) updates.status = status;

        await db.collection('user_providers').updateOne({ providerId }, { $set: updates });

        sendMessage(ws, {
          type: 'provider_updated',
          providerId,
          ...updates,
        } as any);

        console.log(`✅ Updated provider ${providerId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error updating provider:', error);
        sendError(ws, 'UPDATE_PROVIDER_ERROR', 'Failed to update provider');
      }
    },

    /**
     * Handle delete_provider - remove a provider
     */
    async handleDeleteProvider(
      ws: WebSocket,
      userId: string,
      message: { providerId: string },
    ): Promise<void> {
      try {
        const { providerId } = message;

        if (!providerId) {
          sendError(ws, 'MISSING_PROVIDER_ID', 'providerId is required');
          return;
        }

        // Verify ownership
        const providers = await providerService.listUserProviders(userId);
        const owned = providers.find((p) => p.providerId === providerId);
        if (!owned) {
          sendError(ws, 'PROVIDER_NOT_FOUND', 'Provider not found or not owned by user');
          return;
        }

        await db.collection('user_providers').deleteOne({ providerId });

        sendMessage(ws, {
          type: 'provider_deleted',
          providerId,
        } as any);

        console.log(`✅ Deleted provider ${providerId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error deleting provider:', error);
        sendError(ws, 'DELETE_PROVIDER_ERROR', 'Failed to delete provider');
      }
    },

    // ========================================================================
    // OAuth Commands
    // ========================================================================

    /**
     * Handle start_provider_oauth - Start OAuth flow for a provider
     * Returns authorization URL and verifier for the client
     */
    async handleStartProviderOAuth(
      ws: WebSocket,
      userId: string,
      message: { providerType: string },
    ): Promise<void> {
      try {
        const { providerType } = message;

        if (providerType !== 'anthropic-oauth') {
          sendError(ws, 'INVALID_PROVIDER', `OAuth not supported for provider type: ${providerType}`);
          return;
        }

        // Import OAuth functions from core
        const { generateAuthorizationUrl } = await import('@teros/core');
        const { url, verifier } = generateAuthorizationUrl();

        // Store verifier in memory for later exchange (with userId association)
        // Using a simple in-memory map - in production should use Redis
        oauthSessions.set(verifier, {
          verifier,
          userId,
          providerType,
          createdAt: Date.now(),
        });

        sendMessage(ws, {
          type: 'provider_oauth_started',
          providerType,
          authUrl: url,
          verifier,
        } as any);

        console.log(`🔑 Started OAuth flow for user ${userId}, provider ${providerType}`);
      } catch (error) {
        console.error('❌ Error starting OAuth:', error);
        sendError(ws, 'OAUTH_START_ERROR', 'Failed to start OAuth flow');
      }
    },

    /**
     * Handle complete_provider_oauth - Complete OAuth flow with callback URL
     * Exchanges code for tokens and creates/updates the provider
     */
    async handleCompleteProviderOAuth(
      ws: WebSocket,
      userId: string,
      message: { callbackUrl: string; verifier: string },
    ): Promise<void> {
      try {
        const { callbackUrl, verifier } = message;

        if (!callbackUrl || !verifier) {
          sendError(ws, 'INVALID_INPUT', 'callbackUrl and verifier are required');
          return;
        }

        // Get session
        const session = oauthSessions.get(verifier);
        if (!session) {
          sendError(ws, 'INVALID_VERIFIER', 'Invalid or expired verifier. Please start the OAuth flow again.');
          return;
        }

        // Verify userId matches
        if (session.userId !== userId) {
          sendError(ws, 'UNAUTHORIZED', 'OAuth session does not belong to this user');
          return;
        }

        // Exchange code for tokens
        const { exchangeCodeForTokens } = await import('@teros/core');
        const tokens = await exchangeCodeForTokens(callbackUrl, verifier);
        if (!tokens) {
          sendError(ws, 'OAUTH_EXCHANGE_ERROR', 'Failed to exchange code for tokens. Please try again.');
          return;
        }

        // Clean up session
        oauthSessions.delete(verifier);

        // Check if user already has this provider type
        const existingProviders = await providerService.listUserProviders(userId);
        const existing = existingProviders.find(p => p.providerType === session.providerType);

        if (existing) {
          // Update existing provider with new tokens
          await providerService.updateProvider(userId, existing.providerId, {
            auth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
            },
          });

          sendMessage(ws, {
            type: 'provider_oauth_completed',
            success: true,
            providerId: existing.providerId,
            providerType: session.providerType,
            isUpdate: true,
          } as any);

          console.log(`🔑 Updated OAuth provider ${existing.providerId} for user ${userId}`);
        } else {
          // Create new provider
          const provider = await providerService.addProvider(userId, {
            providerType: session.providerType as any,
            displayName: 'Claude Max',
            auth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
            },
          });

          sendMessage(ws, {
            type: 'provider_oauth_completed',
            success: true,
            providerId: provider.providerId,
            providerType: session.providerType,
            isUpdate: false,
          } as any);

          console.log(`🔑 Created OAuth provider ${provider.providerId} for user ${userId}`);
        }
      } catch (error) {
        console.error('❌ Error completing OAuth:', error);
        sendError(ws, 'OAUTH_COMPLETE_ERROR', 'Failed to complete OAuth flow');
      }
    },
  };
}

// ============================================================================
// OAuth Session Storage (in-memory, should be Redis in production)
// ============================================================================

interface OAuthSession {
  verifier: string;
  userId: string;
  providerType: string;
  createdAt: number;
}

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
