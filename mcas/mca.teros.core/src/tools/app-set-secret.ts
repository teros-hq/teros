import type { ToolConfig } from '@teros/mca-sdk';

/**
 * set-app-secret — agent secret tools (docs/specs/20261031_agent-secret-tools.md).
 *
 * `alwaysAsk: true` — the user confirms EVERY write, even when the app's
 * permission for this tool is set to 'allow'.
 */
export const appSetSecret: ToolConfig = {
  description:
    "Store an API key or other secret for an app so it becomes authenticated, WITHOUT the secret staying in the conversation. Use it when you already have the value (the user pasted it, or it appeared in a tool output like SSH/terminal) and the app needs it as a credential — e.g. saving MAKE_API_TOKEN for Make. After saving, every message in this conversation that contains the value is automatically redacted (including this call itself), and the app picks the new value up live (no restart). NEVER echo the secret in your reply — reference it only by the returned mask (e.g. 'ya la tengo: …4f2a'). The key must be one of the app's declared secret fields (the response lists the valid ones if you get it wrong).",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app to store the secret for',
      },
      key: {
        type: 'string',
        description:
          "Secret field name as declared by the app (e.g. 'MAKE_API_TOKEN', 'OPENWEATHER_API_KEY'). Use get-app or check-app-auth to discover the valid field names.",
      },
      value: {
        type: 'string',
        description:
          'The secret value to store. It will be redacted from this conversation right after saving.',
      },
      scope: {
        type: 'string',
        enum: ['user'],
        description:
          "Credential scope. Only 'user' (default): the user's own credential for this app. System-level secrets are admin-only.",
      },
      alsoRedact: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional message ids to also redact when the exact value match misses them (e.g. the key was split across lines or transformed).',
      },
    },
    required: ['appId', 'key', 'value'],
  },
  // Policy flag: this tool can NEVER run without explicit human confirmation —
  // writing a credential on the user's behalf is forbidden-by-design to auto-run.
  annotations: { readOnlyHint: false, alwaysAsk: true },
  handler: async (args, context) => {
    return context.appSetSecret(
      args.appId as string,
      args.key as string,
      args.value as string,
      {
        ...(args.scope ? { scope: args.scope as 'user' | 'app' } : {}),
        ...(Array.isArray(args.alsoRedact) ? { alsoRedact: args.alsoRedact as string[] } : {}),
        ...(context.execution?.agentId ? { agentId: context.execution.agentId } : {}),
      },
    );
  },
};
