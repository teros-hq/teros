import type { ToolConfig } from '@teros/mca-sdk';

/**
 * get-app-secret — agent secret tools (docs/specs/20261031_agent-secret-tools.md).
 *
 * Read-only, returns ONLY a masked preview + metadata. The full value is
 * never returned to the agent — by design, not by convention.
 */
export const appGetSecret: ToolConfig = {
  description:
    "Check whether an app has a stored secret, and see a masked preview of it (e.g. 'sk_live_…4f2a') — the full value is NEVER returned. Use it to verify a key was already saved (after set-app-secret, or by the user from the panel) without exposing it. The mask matches the one shown in redacted messages, so 'the …4f2a key' is a stable reference across the conversation.",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app whose secret to preview',
      },
      key: {
        type: 'string',
        description: 'Secret field name (e.g. MAKE_API_TOKEN)',
      },
      scope: {
        type: 'string',
        enum: ['user', 'app'],
        description: "Credential scope — 'user' (default) or 'app'.",
      },
    },
    required: ['appId', 'key'],
  },
  annotations: { readOnlyHint: true },
  handler: async (args, context) => {
    return context.appGetSecret(args.appId as string, args.key as string, {
      ...(args.scope ? { scope: args.scope as 'user' | 'app' } : {}),
    });
  },
};
