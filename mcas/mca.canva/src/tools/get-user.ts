import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getUser: ToolConfig = {
  description: "Get the current authenticated user's ID and team ID.",
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    return canvaRequest(context, '/users/me');
  },
};
