import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getUser: ToolConfig = {
  description: 'Get the authenticated ClickUp user information.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const data = await clickupRequest(context, '/user') as { user: any };
    const user = data.user;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      color: user.color,
      profilePicture: user.profilePicture,
      timezone: user.timezone,
      weekStartDay: user.week_start_day,
    };
  },
};
