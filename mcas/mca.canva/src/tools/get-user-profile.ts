import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getUserProfile: ToolConfig = {
  description: "Get the current user's profile including display name.",
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    return canvaRequest(context, '/users/me/profile');
  },
};
