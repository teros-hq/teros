/**
 * set-default-provider tool handler — unit tests.
 *
 * The tool bridges to the backend's `provider.*` WsRouter actions via the WS
 * domain_request bridge (src/lib/provider-bridge.ts). We mock the bridge
 * module (mock.module — process-global in bun, restored in afterAll) and
 * assert:
 *   - param validation (missing providerId/modelId)
 *   - the exact provider.list read (validation data source)
 *   - the exact provider.update payload mapping ({providerId, isDefault:true,
 *     defaultModelId, reason})
 *   - error paths: provider not found / not owned, provider inactive, model
 *     not served, backend error passthrough
 *   - the credentials warning (non-blocking) for a secrets-based provider
 *     with no discovered models
 *   - the no-op semantics when setting the CURRENT default (idempotent write)
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { mock } from 'bun:test';

const BRIDGE_PATH = resolve(import.meta.dir, '../../src/lib/provider-bridge');
const realBridge = await import(BRIDGE_PATH);

/** Captured domain_request calls: {action, params}. */
const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

/** Canned responses per action — shifted per call so tests script sequences (list → update). */
let responses: Record<string, Array<() => unknown>> = {};

mock.module(BRIDGE_PATH, () => ({
  ...realBridge,
  isWsConnected: () => true,
  callProviderBackend: async (
    _context: unknown,
    action: string,
    params: Record<string, unknown> = {},
  ) => {
    calls.push({ action, params });
    const queue = responses[action];
    const next = queue?.shift();
    if (!next) throw new Error(`unexpected call to ${action}`);
    return next();
  },
}));

const { providerSetDefault } = await import('../../src/tools/provider-set-default');

afterAll(() => {
  mock.module(BRIDGE_PATH, () => realBridge);
});

beforeEach(() => {
  calls.length = 0;
  responses = {};
});

// biome-ignore lint/suspicious/noExplicitAny: minimal fake ToolContext
const context = {
  execution: { userId: 'user_1', appId: 'app_1', agentId: 'agent_1', channelId: 'ch_1' },
} as any;

const PROVIDERS = [
  {
    providerId: 'prov_teros',
    providerType: 'teros',
    displayName: 'Teros',
    status: 'active',
    isDefault: true,
    defaultModelId: 'teros-glm-5p3',
    models: [{ modelId: 'teros-glm-5p3' }, { modelId: 'teros-glm-5p3-fast' }],
  },
  {
    providerId: 'prov_helm',
    providerType: 'helmcode',
    displayName: 'Helmcode',
    status: 'active',
    isDefault: false,
    defaultModelId: 'helmcode-glm-5.3',
    models: [{ modelId: 'helmcode-glm-5.3' }],
  },
  {
    providerId: 'prov_dead',
    providerType: 'openai',
    displayName: 'Dead OpenAI',
    status: 'disabled',
    isDefault: false,
    models: [{ modelId: 'gpt-x' }],
  },
  {
    providerId: 'prov_nokey',
    providerType: 'helmcode',
    displayName: 'Helmcode sin key',
    status: 'active',
    isDefault: false,
    models: [],
  },
];

function givenProviders(providers = PROVIDERS) {
  responses['provider.list'] = [() => ({ providers })];
}

describe('set-default-provider — payload mapping (the critical contract)', () => {
  it('calls provider.list then provider.update with the exact payload', async () => {
    givenProviders();
    responses['provider.update'] = [
      () => ({ providerId: 'prov_helm', isDefault: true, defaultModelId: 'helmcode-glm-5.3' }),
    ];

    const result = (await providerSetDefault.handler(
      { providerId: 'prov_helm', modelId: 'helmcode-glm-5.3', reason: 'cost' },
      context,
    )) as Record<string, unknown>;

    // Read for validation, then the write.
    expect(calls.map((c) => c.action)).toEqual(['provider.list', 'provider.update']);
    expect(calls[1].params).toEqual({
      providerId: 'prov_helm',
      isDefault: true,
      defaultModelId: 'helmcode-glm-5.3',
      reason: 'cost',
    });
    expect(result.success).toBe(true);
    expect(result.providerId).toBe('prov_helm');
    expect(result.modelId).toBe('helmcode-glm-5.3');
    expect(result.previousDefaultProviderId).toBe('prov_teros');
    expect(result.message).toContain('replaced');
  });

  it('omits reason from the payload when not provided', async () => {
    givenProviders();
    responses['provider.update'] = [() => ({})];

    await providerSetDefault.handler(
      { providerId: 'prov_helm', modelId: 'helmcode-glm-5.3' },
      context,
    );

    expect(calls[1].params).toEqual({
      providerId: 'prov_helm',
      isDefault: true,
      defaultModelId: 'helmcode-glm-5.3',
      reason: undefined,
    });
  });

  it('no-op write when setting the CURRENT default (verification path)', async () => {
    givenProviders();
    responses['provider.update'] = [() => ({})];

    const result = (await providerSetDefault.handler(
      { providerId: 'prov_teros', modelId: 'teros-glm-5p3' },
      context,
    )) as Record<string, unknown>;

    // Still writes (idempotent) — the backend action is safe to re-run.
    expect(calls.map((c) => c.action)).toEqual(['provider.list', 'provider.update']);
    expect(result.message).toContain('already was the default');
  });
});

describe('set-default-provider — validation errors', () => {
  it('rejects missing providerId/modelId before any backend call', async () => {
    await expect(providerSetDefault.handler({ providerId: 'p' }, context)).rejects.toThrow(
      'providerId and modelId are required',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a provider that does not exist / is not owned by the user', async () => {
    givenProviders();
    await expect(
      providerSetDefault.handler({ providerId: 'prov_ghost', modelId: 'm' }, context),
    ).rejects.toThrow("Provider 'prov_ghost' not found or not owned by the user");
    // No write attempted.
    expect(calls.map((c) => c.action)).toEqual(['provider.list']);
  });

  it('rejects an inactive provider', async () => {
    givenProviders();
    await expect(
      providerSetDefault.handler({ providerId: 'prov_dead', modelId: 'gpt-x' }, context),
    ).rejects.toThrow('is disabled — only active providers');
    expect(calls.map((c) => c.action)).toEqual(['provider.list']);
  });

  it('rejects a model not served by the provider, listing what is available', async () => {
    givenProviders();
    await expect(
      providerSetDefault.handler({ providerId: 'prov_helm', modelId: 'wrong-model' }, context),
    ).rejects.toThrow(
      "Model 'wrong-model' is not served by provider 'Helmcode'. Available models: helmcode-glm-5.3",
    );
    expect(calls.map((c) => c.action)).toEqual(['provider.list']);
  });

  it('passes backend errors through verbatim (update fails)', async () => {
    givenProviders();
    responses['provider.update'] = [
      () => {
        throw new Error(
          'provider provider.update failed: Provider not found or not owned by user',
        );
      },
    ];
    await expect(
      providerSetDefault.handler(
        { providerId: 'prov_helm', modelId: 'helmcode-glm-5.3' },
        context,
      ),
    ).rejects.toThrow('Provider not found or not owned by user');
  });
});

describe('set-default-provider — credentials warning (non-blocking)', () => {
  it('rejects a model not in a NON-empty model list (hard error, lists available)', async () => {
    givenProviders();
    await expect(
      providerSetDefault.handler({ providerId: 'prov_helm', modelId: 'wrong-model' }, context),
    ).rejects.toThrow(
      "Model 'wrong-model' is not served by provider 'Helmcode'. Available models: helmcode-glm-5.3",
    );
    expect(calls.map((c) => c.action)).toEqual(['provider.list']);
  });

  it('warns but does NOT block a secrets-based provider with an empty model list (no credentials)', async () => {
    givenProviders();
    responses['provider.update'] = [() => ({})];

    const result = (await providerSetDefault.handler(
      { providerId: 'prov_nokey', modelId: 'anything' },
      context,
    )) as Record<string, unknown>;

    // The write went through despite no models.
    expect(calls.map((c) => c.action)).toEqual(['provider.list', 'provider.update']);
    expect(result.success).toBe(true);
    expect(result.warning).toContain('no discovered models');
    expect(result.warning).toContain('credentials');
  });

  it('warns differently (never tested) for a credential-free provider with an empty model list', async () => {
    const providers = [
      {
        providerId: 'prov_ollama',
        providerType: 'ollama',
        displayName: 'Ollama',
        status: 'active',
        isDefault: false,
        models: [],
      },
    ];
    givenProviders(providers);
    responses['provider.update'] = [() => ({})];

    const result = (await providerSetDefault.handler(
      { providerId: 'prov_ollama', modelId: 'x' },
      context,
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.warning).toContain('never tested');
    expect(result.warning).not.toContain('credentials configured');
  });
});
