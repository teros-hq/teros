import type { ToolConfig } from '@teros/mca-sdk';

export const appShowAuth: ToolConfig = {
  description:
    "Show an app's authentication widget to the user, inline in the chat, so they can connect or re-authenticate it right there (e.g. reconnect Gmail when the OAuth session expired). Use it when an app's tools fail for auth reasons (expired session, missing credentials). Returns the app's current auth status so you can tell the user what needs fixing. Never ask the user for credentials directly — the widget is the only place they should enter them.",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app whose authentication section to show',
      },
    },
    required: ['appId'],
  },
  // Read-only: mutates nothing — the tool result renders as an inline auth
  // widget in the chat (the user completes any re-auth themselves).
  annotations: { readOnlyHint: true },
  handler: async (args, context) => {
    return context.appShowAuth(args.appId as string);
  },
};
