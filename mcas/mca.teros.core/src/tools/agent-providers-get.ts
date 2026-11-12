import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentProvidersGet: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    "Get the LLM model configuration for an agent. Returns ALL of the owner's active providers " +
    '(each with isDefault, defaultModelId and its models), the agent pin ' +
    '(selectedProviderId/selectedModelId, null = System Default), the resolved provider/model a ' +
    'run would actually use (source: agent_pin | user_default_provider | unresolved), and ' +
    'warnings for any orphaned or inconsistent configuration. System Default = the user default ' +
    'provider (isDefault) + its defaultModelId.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to query',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.agentProvidersGet(agentId);
  },
};
