import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentModelSet: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Pin an agent to an exact LLM model. Atomically sets the agent's selected provider + model, " +
    'a single pin — there is no per-agent provider list anymore. Validates that the ' +
    'model is served by the provider and enforces the billing gate. Changing another agent\'s model ' +
    'is a considered decision (platform policy) — pass `reason` to document why. The change ' +
    'broadcasts live to the UI.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to configure',
      },
      providerId: {
        type: 'string',
        description: 'Provider ID that serves the model (e.g. a Teros or Helmcode provider)',
      },
      modelId: {
        type: 'string',
        description: 'Exact model ID to pin (must be in the provider\'s model list)',
      },
      reason: {
        type: 'string',
        description:
          'Why this model change is being made. Recorded in the audit log (who/when/why).',
      },
      allowReserved: {
        type: 'boolean',
        description:
          'Set true only with an explicit operator decision to pin a reserved model ' +
          '(e.g. teros-glm-5p3-fast, exclusive to Alice).',
      },
    },
    required: ['agentId', 'providerId', 'modelId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.agentModelSet(agentId, args.providerId as string, args.modelId as string, {
      reason: args.reason as string | undefined,
      allowReserved: args.allowReserved as boolean | undefined,
    });
  },
};
