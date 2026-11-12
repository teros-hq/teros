import type { ToolConfig } from '@teros/mca-sdk';

/**
 * copy-app-auth — 5th credential tool (task tn_aGVdSrVwIJi9mfvc, Pablo 2-nov).
 * Closes the credential toolset: set / get / check / show / copy.
 *
 * `alwaysAsk: true` — same policy as set-app-secret: writing credentials on
 * the user's behalf NEVER auto-runs; every copy needs human confirmation.
 */
export const appCopyAuth: ToolConfig = {
  description:
    "Copy the COMPLETE authentication of one app instance (user secrets + OAuth tokens with refresh) to another instance of the same app type — e.g. replicate your connected Make credentials to the Make instance in another workspace. Full replace on the target (set semantics, not merge); the target picks the credentials up live, no restart needed. The response lists only the copied field names and their masks (e.g. '…4f2a') — values are NEVER exposed. OAuth caveat: afterwards both instances share the same tokens; if the provider rotates refresh tokens, one instance can invalidate the other. Cross-app-type copies (different mcaId) are blocked, and credentials always stay within the calling user's own apps.",
  parameters: {
    type: 'object',
    properties: {
      sourceAppId: {
        type: 'string',
        description: 'App instance to copy the credentials FROM (must already be connected).',
      },
      targetAppId: {
        type: 'string',
        description:
          'App instance to copy the credentials TO — same app type (mcaId) as the source, typically the same MCA installed in another workspace.',
      },
      sourceWorkspaceId: {
        type: 'string',
        description:
          "Required: the workspace the source app lives in — cross-workspace tools always name their workspaces (Teros infra is sharded by workspaceId, so the tool must know which infrastructure it hits). Validated against the app's actual workspace; catches wrong-appId mistakes before any write.",
      },
      targetWorkspaceId: {
        type: 'string',
        description:
          "Required: the workspace the target app lives in — cross-workspace tools always name their workspaces (Teros infra is sharded by workspaceId). Validated against the app's actual workspace.",
      },
    },
    required: ['sourceAppId', 'targetAppId', 'sourceWorkspaceId', 'targetWorkspaceId'],
  },
  // Policy flag: writing a credential blob to another app instance can NEVER
  // run without explicit human confirmation — same forbidden-by-design rule
  // as set-app-secret.
  annotations: { readOnlyHint: false, alwaysAsk: true },
  handler: async (args, context) => {
    // SDK signature is appCopyAuth(appId /*TARGET*/, sourceAppId, options) —
    // the URL app is the target (its secrets endpoint), the source travels
    // in the body. Args are swapped here on purpose.
    return context.appCopyAuth(
      args.targetAppId as string,
      args.sourceAppId as string,
      {
        sourceWorkspaceId: args.sourceWorkspaceId as string,
        targetWorkspaceId: args.targetWorkspaceId as string,
        ...(context.execution?.agentId ? { agentId: context.execution.agentId } : {}),
      },
    );
  },
};
