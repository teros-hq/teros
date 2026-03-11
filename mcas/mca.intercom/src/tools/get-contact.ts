import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const getContact: ToolConfig = {
  description: 'Get details of an Intercom contact (user or lead) by their Intercom ID.',
  parameters: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: 'The Intercom contact ID',
      },
    },
    required: ['contactId'],
  },
  handler: async (args, context) => {
    const { contactId } = args as { contactId: string };
    const c = (await intercomRequest(context, `/contacts/${contactId}`)) as Record<string, unknown>;
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      email: c.email,
      phone: c.phone,
      createdAt: c.created_at,
      lastSeenAt: c.last_seen_at,
      tags: ((c.tags as any)?.data ?? []).map((t: any) => t.name),
      customAttributes: c.custom_attributes,
    };
  },
};
