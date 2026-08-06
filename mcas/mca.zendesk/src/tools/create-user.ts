import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const createUser: ToolConfig = {
  description:
    'Create a new Zendesk user (end-user, agent, or admin). Returns the created user. Not retryable. Params: name, email, role?, phone?, organizationId?, tags?.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Full name of the user.',
      },
      email: {
        type: 'string',
        description: 'Email address (must be unique).',
      },
      role: {
        type: 'string',
        enum: ['end-user', 'agent', 'admin'],
        description: 'User role. Default: end-user.',
      },
      phone: {
        type: 'string',
        description: 'Phone number.',
      },
      organizationId: {
        type: 'string',
        description: 'Organization ID to associate the user with.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to attach to the user.',
      },
      verified: {
        type: 'boolean',
        description: 'Whether the user is verified. Default true for agents/admins.',
      },
    },
    required: ['name', 'email'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const {
      name,
      email,
      role,
      phone,
      organizationId,
      tags,
      verified,
    } = args as {
      name: string;
      email: string;
      role?: string;
      phone?: string;
      organizationId?: string;
      tags?: string[];
      verified?: boolean;
    };

    const user: Record<string, unknown> = { name, email };
    if (role) user.role = role;
    if (phone) user.phone = phone;
    if (organizationId) user.organization_id = Number(organizationId);
    if (tags) user.tags = tags;
    if (verified !== undefined) user.verified = verified;

    const result = (await zendeskRequest(context, '/users.json', {
      method: 'POST',
      body: { user },
    })) as any;

    const u = result.user;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      createdAt: u.created_at,
      url: u.url,
    };
  },
};
