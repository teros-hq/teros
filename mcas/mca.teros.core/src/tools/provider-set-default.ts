/**
 * set-default-provider — configure the user's System Default (provider+model).
 *
 * The System Default is what EVERY agent without an explicit pin runs on
 * (2-level resolution: pin > user default). Setting it changes the model of
 * all unpinned agents at once — that is why this tool is alwaysAsk.
 *
 * The write goes through the `provider.update` WsRouter action (the same one
 * the Providers window uses) via the WS domain_request bridge, so the atomic
 * isDefault switch (clear others + set this one) is the backend's, not ours.
 * Runtime resolution is live — no restart, the next run picks it up.
 */

import type { ToolConfig } from '@teros/mca-sdk';
import { callProviderBackend } from '../lib/provider-bridge';

/** Shape of a provider entry as returned by the `provider.list` action. */
interface ProviderListEntry {
  providerId: string;
  providerType: string;
  displayName: string;
  status: string;
  isDefault?: boolean;
  defaultModelId?: string | null;
  models?: Array<{ modelId: string }>;
  config?: Record<string, unknown>;
}

/**
 * Providers whose credentials live in `config` (e.g. ollama baseUrl) or are
 * managed server-side (teros) — no user secrets needed. Mirrors
 * PROVIDER_TYPES_WITHOUT_SECRETS in the backend's provider-service.
 */
const PROVIDER_TYPES_WITHOUT_SECRETS: readonly string[] = [
  'ollama',
  'openai-compatible',
  'teros',
];

/**
 * Warning for a provider with no discovered models — the visible symptom of
 * "no credentials configured" (models are discovered by test-provider, which
 * needs working credentials). Non-blocking per platform policy: the user may
 * want to pre-configure the default before adding the key. Credential-free
 * types (ollama/teros/…) just haven't been tested yet.
 */
function credentialsWarning(provider: ProviderListEntry): string | null {
  if ((provider.models ?? []).length > 0) return null;
  if (PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType)) {
    return (
      `Provider '${provider.displayName}' has no discovered models yet (never tested). ` +
      `The model ID could not be validated against its model list.`
    );
  }
  return (
    `Provider '${provider.displayName}' has no discovered models — it likely has no ` +
    `credentials configured (no API key / OAuth). The model ID could not be validated, ` +
    `and runs on it will fail until it is configured. Set anyway if that is intended.`
  );
}

export const providerSetDefault: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Set the user's System Default provider + model — what EVERY agent without an explicit " +
    'model pin runs on. This is the highest-blast-radius model setting: changing it switches ' +
    'the model of ALL unpinned agents at once (agents pinned via set-agent-model are NOT ' +
    'affected). Use list-providers first to see current providers, their models and which ' +
    'one is the current default. The switch is atomic (only one default at a time) and the ' +
    'change is live — no restart needed, the next run resolves the new default. Broadcasts ' +
    'live to the UI.',
  parameters: {
    type: 'object',
    properties: {
      providerId: {
        type: 'string',
        description:
          "Provider ID to set as System Default (from list-providers). Must be active and owned by the user.",
      },
      modelId: {
        type: 'string',
        description:
          "Exact model ID to use as the provider's default model (must be in the provider's model list from list-providers).",
      },
      reason: {
        type: 'string',
        description:
          'Why the System Default is being changed. Recorded in the audit log (who/when/why) — this affects every unpinned agent.',
      },
    },
    required: ['providerId', 'modelId'],
  },
  handler: async (args, context) => {
    const providerId = args.providerId as string;
    const modelId = args.modelId as string;

    if (!providerId || !modelId) {
      throw new Error('providerId and modelId are required. Use list-providers to find them.');
    }

    // ── Validation (read path first — cheap, and gives a helpful answer) ──
    const { providers } = await callProviderBackend<{ providers: ProviderListEntry[] }>(
      context,
      'provider.list',
    );
    const provider = providers.find((p) => p.providerId === providerId);

    if (!provider) {
      throw new Error(
        `Provider '${providerId}' not found or not owned by the user. ` +
          'Use list-providers to see valid provider IDs.',
      );
    }

    if (provider.status !== 'active') {
      throw new Error(
        `Provider '${provider.displayName}' is ${provider.status} — only active providers ` +
          'can be the System Default.',
      );
    }

    const served = (provider.models ?? []).some((m) => m.modelId === modelId);
    if (!served && (provider.models ?? []).length > 0) {
      throw new Error(
        `Model '${modelId}' is not served by provider '${provider.displayName}'. ` +
          `Available models: ${(provider.models ?? []).map((m) => m.modelId).join(', ')}`,
      );
    }
    // Empty model list (untested/unconfigured provider) → NOT a hard error:
    // the credentialsWarning below flags it in the result instead.

    const wasDefault = provider.isDefault === true;
    const previousDefault = providers.find((p) => p.isDefault === true);

    // ── Write: the atomic isDefault switch is the backend action's ──
    const result = await callProviderBackend<Record<string, unknown>>(context, 'provider.update', {
      providerId,
      isDefault: true,
      defaultModelId: modelId,
      reason: args.reason as string | undefined,
    });

    const warning = credentialsWarning(provider);

    return {
      success: true,
      message:
        `System Default set to '${provider.displayName}' / ${modelId}` +
        (wasDefault
          ? ' (already was the default — default model updated)'
          : previousDefault
            ? ` — replaced '${previousDefault.displayName}' as default`
            : ''),
      providerId,
      providerName: provider.displayName,
      modelId,
      previousDefaultProviderId: previousDefault?.providerId ?? null,
      ...(warning ? { warning } : {}),
      ...(result ?? {}),
    };
  },
};
