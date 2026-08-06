/**
 * Tests for LLMClientManager
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ILLMClient } from '@teros/core';
import { createLLMClientManager } from '../../../../packages/backend/src/handlers/message/llm-client-manager';

describe('LLMClientManager', () => {
  // Mock LLM client
  const createMockClient = (): ILLMClient =>
    ({
      chat: mock(() => Promise.resolve({ content: 'test' })),
      stream: mock(() => Promise.resolve()),
    }) as unknown as ILLMClient;

  describe('with mock client', () => {
    it('should return mock client when provided', async () => {
      const mockClient = createMockClient();
      const manager = createLLMClientManager({
        mockClient,
      });

      const config = {
        provider: 'anthropic' as const,
        modelString: 'claude-3-sonnet',
        maxTokens: 4096,
        context: { maxTokens: 200000 },
      };

      const client = await manager.getClient(config);
      expect(client).toBe(mockClient);
    });

    it('should always return mock client regardless of config', async () => {
      const mockClient = createMockClient();
      const manager = createLLMClientManager({
        mockClient,
      });

      const config1 = {
        provider: 'anthropic' as const,
        modelString: 'claude-3-sonnet',
        maxTokens: 4096,
        context: { maxTokens: 200000 },
      };

      const config2 = {
        provider: 'openai' as const,
        modelString: 'gpt-4',
        maxTokens: 4096,
        context: { maxTokens: 128000 },
      };

      const client1 = await manager.getClient(config1);
      const client2 = await manager.getClient(config2);

      expect(client1).toBe(mockClient);
      expect(client2).toBe(mockClient);
    });
  });

  describe('cache management', () => {
    it('should clear specific cache entry', async () => {
      const mockClient = createMockClient();
      const manager = createLLMClientManager({
        mockClient,
      });

      // Get a client to populate cache (mock client bypasses cache but we test the API)
      await manager.getClient({
        provider: 'anthropic' as const,
        modelString: 'claude-3-sonnet',
        maxTokens: 4096,
        context: { maxTokens: 200000 },
      });

      // Should not throw
      manager.clearCache('anthropic', 'claude-3-sonnet');
    });

    it('should clear all cache entries', async () => {
      const mockClient = createMockClient();
      const manager = createLLMClientManager({
        mockClient,
      });

      // Should not throw
      manager.clearAllCache();
    });
  });

  describe('unsupported providers', () => {
    it('should return null for unsupported provider without mock', async () => {
      // getClient now requires resolvedCredentials as second parameter (signature drift).
      // The provider is determined by resolvedCredentials.providerType, not config.provider.
      const manager = createLLMClientManager({});

      const config = {
        provider: 'unsupported-provider' as any,
        modelString: 'some-model',
        maxTokens: 4096,
        context: { maxTokens: 100000 },
      };

      // Pass mock credentials with an unsupported providerType
      const resolvedCredentials = {
        providerId: 'provider_unsupported',
        providerType: 'unsupported-provider' as any,
        apiKey: 'fake-key',
      };

      const client = await manager.getClient(config, resolvedCredentials);
      expect(client).toBeNull();
    });
  });

  // bug tracker
  // @todo alice - 2026-04-02: fix bug — audit all call sites of getClient and pass resolvedCredentials; consider making the param optional with a safe fallback to avoid hard crashes
  it.todo('bug: getClient added resolvedCredentials as a required second parameter without updating existing call sites — callers that omit it will crash at resolvedCredentials.providerId');
});
