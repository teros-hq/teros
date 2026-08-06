import type { ToolConfig } from '@teros/mca-sdk';

export const appPermissionsSet: ToolConfig = {
  description:
    "Set tool permissions for an app, in batch. Values: 'allow' (runs without asking), 'ask' (requires user confirmation), 'forbid' (blocked), 'default' (clear the explicit setting so the tool falls back to the app default). Use `tools` for per-tool changes and/or `all` to change every tool at once; `all: 'default'` resets the whole app to defaults.",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app whose permissions to change',
      },
      all: {
        type: 'string',
        enum: ['allow', 'ask', 'forbid', 'default'],
        description:
          "Set every tool of the app at once; 'default' resets all tools to the app default",
      },
      tools: {
        type: 'object',
        description:
          "Per-tool changes: a map of tool name to 'allow' | 'ask' | 'forbid' | 'default'. Applied on top of `all` when both are given.",
        additionalProperties: {
          type: 'string',
          enum: ['allow', 'ask', 'forbid', 'default'],
        },
      },
    },
    required: ['appId'],
  },
  annotations: { readOnlyHint: false, alwaysAsk: true },
  handler: async (args, context) => {
    const all = args.all as string | undefined;
    const tools = args.tools as Record<string, string> | undefined;
    if (all === undefined && (!tools || Object.keys(tools).length === 0)) {
      throw new Error("Provide 'all' and/or a non-empty 'tools' map");
    }
    return context.appPermissionsSet(args.appId as string, { all, tools });
  },
};
