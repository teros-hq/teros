import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const assignConversation: ToolConfig = {
  description:
    'Assign an Intercom conversation to a specific admin or team. Can also unassign by omitting both.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The Intercom conversation ID',
      },
      adminId: {
        type: 'string',
        description: 'Admin ID to assign the conversation to',
      },
      teamId: {
        type: 'string',
        description: 'Team ID to assign the conversation to',
      },
    },
    required: ['conversationId'],
  },
  handler: async (args, context) => {
    const { conversationId, adminId, teamId } = args as {
      conversationId: string;
      adminId?: string;
      teamId?: string;
    };

    const me = (await intercomRequest(context, '/me')) as Record<string, unknown>;

    const body: Record<string, unknown> = {
      message_type: 'assignment',
      type: 'admin',
      admin_id: me.id,
    };

    if (adminId) body.assignee_id = adminId;
    if (teamId) body.team_id = teamId;

    return intercomRequest(context, `/conversations/${conversationId}/reply`, {
      method: 'POST',
      body,
    });
  },
};
